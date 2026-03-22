import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, toIsoTimestamp } from "@agentic-polymarket/persistence";

type AgentStatus = "pending_verification" | "active" | "suspended" | "disabled";

type AgentRecord = {
  id: string;
  developer_id: string;
  name: string;
  runtime_type: string;
  public_key: string;
  status: AgentStatus;
  created_at: string;
  verified_at: string | null;
};

type AgentRow = {
  id: string;
  developer_id: string;
  name: string;
  runtime_type: string;
  public_key: string;
  status: AgentStatus;
  created_at: unknown;
  verified_at: unknown;
};

type ChallengeRow = {
  id: string;
  agent_id: string;
  payload: string;
  expires_at: unknown;
  created_at: unknown;
  used_at: unknown;
};

type TokenRow = {
  token_hash: string;
  agent_id: string;
  expires_at: unknown;
  created_at: unknown;
  revoked_at: unknown;
};

const port = Number(process.env.AUTH_REGISTRY_PORT ?? 4002);
const tokenLifetimeMs = Number(process.env.AUTH_TOKEN_TTL_MS ?? 60 * 60_000);
const challengeLifetimeMs = Number(process.env.AUTH_CHALLENGE_TTL_MS ?? 5 * 60_000);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

function mapAgentRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    developer_id: row.developer_id,
    name: row.name,
    runtime_type: row.runtime_type,
    public_key: row.public_key,
    status: row.status,
    created_at: toIsoTimestamp(row.created_at),
    verified_at: row.verified_at ? toIsoTimestamp(row.verified_at) : null,
  };
}

async function getAgent(agentId: string) {
  const result = await pool.query<AgentRow>(
    `
      SELECT id, developer_id, name, runtime_type, public_key, status, created_at, verified_at
      FROM agents
      WHERE id = $1
    `,
    [agentId],
  );

  return result.rowCount ? mapAgentRow(result.rows[0]) : null;
}

async function saveAgent(agent: AgentRecord) {
  const result = await pool.query<AgentRow>(
    `
      INSERT INTO agents (
        id,
        developer_id,
        name,
        runtime_type,
        public_key,
        status,
        created_at,
        verified_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        developer_id = EXCLUDED.developer_id,
        name = EXCLUDED.name,
        runtime_type = EXCLUDED.runtime_type,
        public_key = EXCLUDED.public_key,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        verified_at = EXCLUDED.verified_at
      RETURNING id, developer_id, name, runtime_type, public_key, status, created_at, verified_at
    `,
    [
      agent.id,
      agent.developer_id,
      agent.name,
      agent.runtime_type,
      agent.public_key,
      agent.status,
      agent.created_at,
      agent.verified_at,
    ],
  );

  return mapAgentRow(result.rows[0]);
}

async function getChallenge(challengeId: string) {
  const result = await pool.query<ChallengeRow>(
    `
      SELECT id, agent_id, payload, expires_at, created_at, used_at
      FROM auth_challenges
      WHERE id = $1
    `,
    [challengeId],
  );

  return result.rowCount ? result.rows[0] : null;
}

async function markChallengeUsed(challengeId: string) {
  await pool.query(
    `
      UPDATE auth_challenges
      SET used_at = NOW()
      WHERE id = $1
    `,
    [challengeId],
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function verifyDetachedSignature(publicKeyPem: string, payload: string, signature: string) {
  try {
    const key = createPublicKey(publicKeyPem);
    return verifySignature(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

app.get("/health", async () => ({ service: "auth-registry", status: "ok" }));

app.post("/v1/agents/register", async (request, reply) => {
  const body = request.body as {
    developer_id?: string;
    name?: string;
    runtime_type?: string;
    public_key?: string;
  };

  if (!body.developer_id || !body.name || !body.runtime_type || !body.public_key) {
    reply.code(400);
    return { error: "invalid_agent_registration_request" };
  }

  const agent = await saveAgent({
    id: randomUUID(),
    developer_id: body.developer_id,
    name: body.name,
    runtime_type: body.runtime_type,
    public_key: body.public_key,
    status: "pending_verification",
    created_at: new Date().toISOString(),
    verified_at: null,
  });

  reply.code(201);
  return agent;
});

app.get("/v1/agents/:agentId", async (request, reply) => {
  const { agentId } = request.params as { agentId: string };
  const agent = await getAgent(agentId);
  if (!agent) {
    reply.code(404);
    return { error: "agent_not_found" };
  }
  return agent;
});

app.post("/v1/agents/auth/challenge", async (request, reply) => {
  const body = request.body as { agent_id?: string };
  if (!body.agent_id) {
    reply.code(400);
    return { error: "missing_agent_id" };
  }

  const agent = await getAgent(body.agent_id);
  if (!agent) {
    reply.code(404);
    return { error: "agent_not_found" };
  }
  if (agent.status === "suspended" || agent.status === "disabled") {
    reply.code(403);
    return { error: "agent_not_allowed" };
  }

  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + challengeLifetimeMs).toISOString();
  const payload = `agentic-polymarket.auth.${agent.id}.${challengeId}.${expiresAt}`;

  await pool.query(
    `
      INSERT INTO auth_challenges (id, agent_id, payload, expires_at, created_at, used_at)
      VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, NULL)
    `,
    [challengeId, agent.id, payload, expiresAt, new Date().toISOString()],
  );

  return {
    challenge_id: challengeId,
    payload,
    expires_at: expiresAt,
  };
});

app.post("/v1/agents/auth/verify", async (request, reply) => {
  const body = request.body as {
    agent_id?: string;
    challenge_id?: string;
    signature?: string;
  };

  if (!body.agent_id || !body.challenge_id || !body.signature) {
    reply.code(400);
    return { error: "invalid_verify_request" };
  }

  const [agent, challenge] = await Promise.all([
    getAgent(body.agent_id),
    getChallenge(body.challenge_id),
  ]);

  if (!agent || !challenge || challenge.agent_id !== body.agent_id) {
    reply.code(401);
    return { error: "invalid_challenge_or_signature" };
  }
  if (challenge.used_at) {
    reply.code(409);
    return { error: "challenge_already_used" };
  }
  if (new Date(toIsoTimestamp(challenge.expires_at)).getTime() < Date.now()) {
    reply.code(401);
    return { error: "challenge_expired" };
  }
  if (!verifyDetachedSignature(agent.public_key, challenge.payload, body.signature)) {
    reply.code(401);
    return { error: "invalid_challenge_or_signature" };
  }

  await markChallengeUsed(challenge.id);

  if (agent.status === "pending_verification") {
    agent.status = "active";
    agent.verified_at = new Date().toISOString();
    await saveAgent(agent);
  }

  const rawAccessToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawAccessToken);
  const expiresAt = new Date(Date.now() + tokenLifetimeMs).toISOString();

  await pool.query(
    `
      INSERT INTO agent_tokens (token_hash, agent_id, expires_at, created_at, revoked_at)
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz, NULL)
    `,
    [tokenHash, agent.id, expiresAt, new Date().toISOString()],
  );

  return {
    access_token: rawAccessToken,
    token_type: "Bearer",
    expires_at: expiresAt,
    agent: await getAgent(agent.id),
  };
});

app.post("/v1/internal/tokens/introspect", async (request, reply) => {
  const body = request.body as { token?: string };
  if (!body.token) {
    reply.code(400);
    return { error: "missing_token" };
  }

  const tokenHash = sha256(body.token);
  const result = await pool.query<TokenRow>(
    `
      SELECT token_hash, agent_id, expires_at, created_at, revoked_at
      FROM agent_tokens
      WHERE token_hash = $1
    `,
    [tokenHash],
  );

  if (!result.rowCount) {
    reply.code(401);
    return { active: false };
  }

  const token = result.rows[0];
  if (token.revoked_at || new Date(toIsoTimestamp(token.expires_at)).getTime() < Date.now()) {
    reply.code(401);
    return { active: false };
  }

  const agent = await getAgent(token.agent_id);
  if (!agent || agent.status !== "active") {
    reply.code(401);
    return { active: false };
  }

  return {
    active: true,
    agent,
    expires_at: toIsoTimestamp(token.expires_at),
  };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
