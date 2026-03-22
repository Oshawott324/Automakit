import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";

type AgentRecord = {
  id: string;
  developer_id: string;
  name: string;
  runtime_type: string;
  public_key: string;
  status: "pending_verification" | "active" | "suspended" | "disabled";
};

const port = Number(process.env.AUTH_REGISTRY_PORT ?? 4002);
const app = Fastify({ logger: true });
const agents = new Map<string, AgentRecord>();
const challenges = new Map<string, { agent_id: string; payload: string }>();

app.get("/health", async () => ({ service: "auth-registry", status: "ok" }));

app.post("/v1/agents/register", async (request, reply) => {
  const body = request.body as {
    developer_id?: string;
    name?: string;
    runtime_type?: string;
    public_key?: string;
  };

  const agent: AgentRecord = {
    id: randomUUID(),
    developer_id: body.developer_id ?? "dev_seed",
    name: body.name ?? "unnamed-agent",
    runtime_type: body.runtime_type ?? "custom",
    public_key: body.public_key ?? "seed-public-key",
    status: "pending_verification",
  };

  agents.set(agent.id, agent);
  reply.code(201);
  return agent;
});

app.post("/v1/agents/auth/challenge", async (request) => {
  const body = request.body as { agent_id?: string };
  const challengeId = randomUUID();
  const payload = `agentic-polymarket:${body.agent_id ?? "unknown"}:${challengeId}`;

  challenges.set(challengeId, {
    agent_id: body.agent_id ?? "unknown",
    payload,
  });

  return {
    challenge_id: challengeId,
    payload,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
});

app.post("/v1/agents/auth/verify", async (request, reply) => {
  const body = request.body as {
    agent_id?: string;
    challenge_id?: string;
    signature?: string;
  };
  const challenge = body.challenge_id ? challenges.get(body.challenge_id) : undefined;

  if (!challenge || challenge.agent_id !== body.agent_id || !body.signature) {
    reply.code(401);
    return { error: "invalid_challenge_or_signature" };
  }

  const agent = body.agent_id ? agents.get(body.agent_id) : undefined;
  if (agent) {
    agent.status = "active";
  }

  return {
    access_token: createHash("sha256").update(`${body.agent_id}:${body.signature}`).digest("hex"),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
});

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
