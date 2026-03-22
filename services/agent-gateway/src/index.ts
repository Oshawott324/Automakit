import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import Fastify from "fastify";
import type { PoolClient } from "pg";
import { createDatabasePool, ensureCoreSchema, toIsoTimestamp } from "@agentic-polymarket/persistence";

type AgentContext = {
  id: string;
  public_key: string;
  status: "pending_verification" | "active" | "suspended" | "disabled";
};

type IntrospectionResponse = {
  active: boolean;
  agent?: AgentContext;
  expires_at?: string;
};

type OrderStatus = "open" | "partially_filled" | "filled" | "canceled";
type Side = "buy" | "sell";
type Outcome = "YES" | "NO";

type OrderRow = {
  id: string;
  agent_id: string;
  market_id: string;
  client_order_id: string;
  idempotency_key: string;
  side: Side;
  outcome: Outcome;
  price: unknown;
  size: unknown;
  filled_size: unknown;
  status: OrderStatus;
  signed_at: unknown;
  request_signature: string;
  created_at: unknown;
  updated_at: unknown;
  canceled_at: unknown;
};

type FillRow = {
  id: string;
  market_id: string;
  outcome: Outcome;
  price: unknown;
  size: unknown;
  buy_order_id: string;
  sell_order_id: string;
  buy_agent_id: string;
  sell_agent_id: string;
  executed_at: unknown;
};

type MatchingFill = {
  fill_id: string;
  market_id: string;
  outcome: Outcome;
  price: number;
  size: number;
  buy_order_id: string;
  sell_order_id: string;
  buy_agent_id: string;
  sell_agent_id: string;
  executed_at: string;
};

type MatchingOrderUpdate = {
  order_id: string;
  filled_size: number;
  remaining_size: number;
  status: OrderStatus;
};

type MatchingSubmitResponse = {
  order_id: string;
  status: OrderStatus;
  filled_size: number;
  remaining_size: number;
  fills: MatchingFill[];
  touched_orders: MatchingOrderUpdate[];
};

declare module "fastify" {
  interface FastifyRequest {
    agentContext?: AgentContext;
  }
}

const port = Number(process.env.AGENT_GATEWAY_PORT ?? 4001);
const authRegistryUrl = process.env.AUTH_REGISTRY_URL ?? "http://localhost:4002";
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";
const matchingEngineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:7400";
const defaultCashBalance = Number(process.env.AGENT_DEFAULT_CASH_BALANCE ?? 100000);
const maxSignatureAgeMs = Number(process.env.AGENT_REQUEST_MAX_AGE_MS ?? 5 * 60_000);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function buildSignedPayload(method: string, path: string, agentId: string, timestamp: string, body: unknown) {
  return [method.toUpperCase(), path, agentId, timestamp, sha256(stableStringify(body ?? {}))].join("\n");
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

function mapOrderRow(row: OrderRow) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    market_id: row.market_id,
    client_order_id: row.client_order_id,
    side: row.side,
    outcome: row.outcome,
    price: Number(row.price),
    size: Number(row.size),
    filled_size: Number(row.filled_size),
    status: row.status,
    signed_at: toIsoTimestamp(row.signed_at),
    request_signature: row.request_signature,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    canceled_at: row.canceled_at ? toIsoTimestamp(row.canceled_at) : null,
  };
}

function mapFillRow(row: FillRow) {
  return {
    id: row.id,
    market_id: row.market_id,
    outcome: row.outcome,
    price: Number(row.price),
    size: Number(row.size),
    buy_order_id: row.buy_order_id,
    sell_order_id: row.sell_order_id,
    buy_agent_id: row.buy_agent_id,
    sell_agent_id: row.sell_agent_id,
    executed_at: toIsoTimestamp(row.executed_at),
  };
}

async function introspectToken(token: string): Promise<IntrospectionResponse> {
  const response = await fetch(`${authRegistryUrl}/v1/internal/tokens/introspect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    return { active: false };
  }

  return (await response.json()) as IntrospectionResponse;
}

async function ensureMarketExists(marketId: string) {
  const response = await fetch(`${marketServiceUrl}/v1/markets/${marketId}`);
  return response.ok;
}

async function submitToMatchingEngine(body: {
  order_id: string;
  agent_id: string;
  market_id: string;
  side: Side;
  outcome: Outcome;
  price: number;
  size: number;
  created_at: string;
}) {
  const response = await fetch(`${matchingEngineUrl}/v1/internal/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`matching_engine_submit_failed:${response.status}`);
  }

  return (await response.json()) as MatchingSubmitResponse;
}

async function cancelAtMatchingEngine(body: {
  order_id: string;
  market_id: string;
  side: Side;
  outcome: Outcome;
}) {
  const response = await fetch(`${matchingEngineUrl}/v1/internal/orders/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`matching_engine_cancel_failed:${response.status}`);
  }

  return (await response.json()) as { order_id: string; canceled: boolean };
}

async function appendAcceptedOrderEvent(
  client: PoolClient,
  event: {
    order_id: string;
    agent_id: string;
    market_id: string;
    side: Side;
    outcome: Outcome;
    price: number;
    size: number;
    created_at: string;
  },
) {
  await client.query(
    `
      INSERT INTO order_events (
        event_id,
        event_type,
        order_id,
        market_id,
        agent_id,
        side,
        outcome,
        price,
        size,
        created_at
      )
      VALUES (
        $1, 'accepted', $2, $3, $4, $5, $6, $7, $8, $9::timestamptz
      )
    `,
    [
      randomUUID(),
      event.order_id,
      event.market_id,
      event.agent_id,
      event.side,
      event.outcome,
      event.price,
      event.size,
      event.created_at,
    ],
  );
}

async function insertFillsAndUpdateMarketStats(client: PoolClient, fills: MatchingFill[]) {
  if (fills.length === 0) {
    return;
  }

  for (const fill of fills) {
    await client.query(
      `
        INSERT INTO fills (
          id,
          market_id,
          outcome,
          price,
          size,
          buy_order_id,
          sell_order_id,
          buy_agent_id,
          sell_agent_id,
          executed_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        fill.fill_id,
        fill.market_id,
        fill.outcome,
        fill.price,
        fill.size,
        fill.buy_order_id,
        fill.sell_order_id,
        fill.buy_agent_id,
        fill.sell_agent_id,
        fill.executed_at,
      ],
    );

    await client.query(
      `
        INSERT INTO order_events (
          event_id,
          event_type,
          market_id,
          outcome,
          price,
          size,
          buy_order_id,
          sell_order_id,
          created_at
        )
        VALUES (
          $1, 'fill', $2, $3, $4, $5, $6, $7, $8::timestamptz
        )
      `,
      [
        randomUUID(),
        fill.market_id,
        fill.outcome,
        fill.price,
        fill.size,
        fill.buy_order_id,
        fill.sell_order_id,
        fill.executed_at,
      ],
    );

    const lastTradedYesPrice = fill.outcome === "YES" ? fill.price : 1 - fill.price;
    await client.query(
      `
        UPDATE markets
        SET
          last_traded_price_yes = $2,
          volume_24h = volume_24h + $3
        WHERE id = $1
      `,
      [fill.market_id, lastTradedYesPrice, fill.size],
    );
  }
}

async function appendCanceledOrderEvent(client: PoolClient, order: OrderRow) {
  await client.query(
    `
      INSERT INTO order_events (
        event_id,
        event_type,
        order_id,
        market_id,
        agent_id,
        side,
        outcome,
        price,
        size,
        created_at
      )
      VALUES (
        $1, 'canceled', $2, $3, $4, $5, $6, $7, $8, NOW()
      )
    `,
    [
      randomUUID(),
      order.id,
      order.market_id,
      order.agent_id,
      order.side,
      order.outcome,
      Number(order.price),
      Math.max(Number(order.size) - Number(order.filled_size), 0),
    ],
  );
}

app.get("/health", async () => ({ service: "agent-gateway", status: "ok" }));

app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/health") {
    return;
  }

  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    reply.code(401);
    return reply.send({ error: "missing_or_invalid_authorization" });
  }

  const token = authorization.slice("Bearer ".length).trim();
  const introspection = await introspectToken(token);
  if (!introspection.active || !introspection.agent) {
    reply.code(401);
    return reply.send({ error: "inactive_or_unknown_token" });
  }

  request.agentContext = introspection.agent;

  if (request.method !== "POST" || !request.url.startsWith("/v1/orders")) {
    return;
  }

  const agentId = request.headers["x-agent-id"];
  const timestamp = request.headers["x-agent-timestamp"];
  const signature = request.headers["x-agent-signature"];

  if (typeof agentId !== "string" || typeof timestamp !== "string" || typeof signature !== "string") {
    reply.code(400);
    return reply.send({ error: "missing_signed_request_headers" });
  }
  if (agentId !== introspection.agent.id) {
    reply.code(403);
    return reply.send({ error: "token_subject_mismatch" });
  }

  const signedAt = new Date(timestamp).getTime();
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > maxSignatureAgeMs) {
    reply.code(401);
    return reply.send({ error: "stale_or_invalid_request_timestamp" });
  }

  const signedPath = (request as { routerPath?: string }).routerPath ?? request.url;
  const payload = buildSignedPayload(request.method, signedPath, agentId, timestamp, request.body);
  if (!verifyDetachedSignature(introspection.agent.public_key, payload, signature)) {
    reply.code(401);
    return reply.send({ error: "invalid_request_signature" });
  }
});

app.get("/v1/portfolio", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const [reservedResult, notionalResult, positionsResult] = await Promise.all([
    pool.query<{ reserved_balance: unknown }>(
      `
        SELECT COALESCE(SUM(price * GREATEST(size - filled_size, 0)), 0) AS reserved_balance
        FROM orders
        WHERE agent_id = $1
          AND side = 'buy'
          AND status IN ('open', 'partially_filled')
      `,
      [agent.id],
    ),
    pool.query<{ buy_notional: unknown; sell_notional: unknown }>(
      `
        SELECT
          COALESCE(SUM(CASE WHEN buy_agent_id = $1 THEN price * size ELSE 0 END), 0) AS buy_notional,
          COALESCE(SUM(CASE WHEN sell_agent_id = $1 THEN price * size ELSE 0 END), 0) AS sell_notional
        FROM fills
        WHERE buy_agent_id = $1 OR sell_agent_id = $1
      `,
      [agent.id],
    ),
    pool.query<{
      market_id: string;
      outcome: Outcome;
      quantity: unknown;
      bought_qty: unknown;
      bought_notional: unknown;
      mark_price_yes: unknown;
    }>(
      `
        SELECT
          f.market_id,
          f.outcome,
          SUM(CASE WHEN f.buy_agent_id = $1 THEN f.size ELSE -f.size END) AS quantity,
          SUM(CASE WHEN f.buy_agent_id = $1 THEN f.size ELSE 0 END) AS bought_qty,
          SUM(CASE WHEN f.buy_agent_id = $1 THEN f.price * f.size ELSE 0 END) AS bought_notional,
          MAX(m.last_traded_price_yes) AS mark_price_yes
        FROM fills f
        JOIN markets m ON m.id = f.market_id
        WHERE f.buy_agent_id = $1 OR f.sell_agent_id = $1
        GROUP BY f.market_id, f.outcome
        HAVING SUM(CASE WHEN f.buy_agent_id = $1 THEN f.size ELSE -f.size END) <> 0
      `,
      [agent.id],
    ),
  ]);

  const reservedBalance = Number(reservedResult.rows[0]?.reserved_balance ?? 0);
  const buyNotional = Number(notionalResult.rows[0]?.buy_notional ?? 0);
  const sellNotional = Number(notionalResult.rows[0]?.sell_notional ?? 0);
  const cashBalance = defaultCashBalance - buyNotional + sellNotional - reservedBalance;

  const positions = positionsResult.rows.map((row) => {
    const quantity = Number(row.quantity);
    const boughtQty = Number(row.bought_qty);
    const boughtNotional = Number(row.bought_notional);
    const markPriceYes = Number(row.mark_price_yes ?? 0);
    const markPrice = row.outcome === "YES" ? markPriceYes : 1 - markPriceYes;

    return {
      market_id: row.market_id,
      outcome: row.outcome,
      quantity,
      average_price: boughtQty > 0 ? boughtNotional / boughtQty : 0,
      mark_price: markPrice,
    };
  });

  return {
    agent_id: agent.id,
    cash_balance: cashBalance,
    reserved_balance: reservedBalance,
    realized_pnl: 0,
    unrealized_pnl: 0,
    positions,
  };
});

app.post("/v1/orders", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const idempotencyKey = request.headers["idempotency-key"];
  const signedTimestamp = request.headers["x-agent-timestamp"];
  const requestSignature = request.headers["x-agent-signature"];
  if (
    typeof idempotencyKey !== "string" ||
    typeof signedTimestamp !== "string" ||
    typeof requestSignature !== "string"
  ) {
    reply.code(400);
    return { error: "missing_order_headers" };
  }

  const body = request.body as {
    market_id?: string;
    side?: Side;
    outcome?: Outcome;
    price?: number;
    size?: number;
    client_order_id?: string;
  };

  if (
    !body.market_id ||
    !body.side ||
    !body.outcome ||
    typeof body.price !== "number" ||
    typeof body.size !== "number" ||
    !body.client_order_id
  ) {
    reply.code(400);
    return { error: "invalid_order_request" };
  }
  if (!(await ensureMarketExists(body.market_id))) {
    reply.code(404);
    return { error: "market_not_found" };
  }

  const existing = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );

  if (existing.rowCount) {
    reply.code(409);
    return { error: "duplicate_idempotency_key", order: mapOrderRow(existing.rows[0]) };
  }

  const orderId = randomUUID();
  const orderCreatedAt = new Date().toISOString();
  let matchingResult: MatchingSubmitResponse;
  try {
    matchingResult = await submitToMatchingEngine({
      order_id: orderId,
      agent_id: agent.id,
      market_id: body.market_id,
      side: body.side,
      outcome: body.outcome,
      price: body.price,
      size: body.size,
      created_at: orderCreatedAt,
    });
  } catch (error) {
    reply.code(502);
    return { error: String(error) };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const takerUpdate =
      matchingResult.touched_orders.find((entry) => entry.order_id === orderId) ??
      ({
        order_id: orderId,
        filled_size: matchingResult.filled_size,
        remaining_size: matchingResult.remaining_size,
        status: matchingResult.status,
      } satisfies MatchingOrderUpdate);

    await client.query(
      `
        INSERT INTO orders (
          id,
          agent_id,
          market_id,
          client_order_id,
          idempotency_key,
          side,
          outcome,
          price,
          size,
          filled_size,
          status,
          signed_at,
          request_signature,
          created_at,
          updated_at,
          canceled_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::timestamptz, $15::timestamptz, NULL
        )
      `,
      [
        orderId,
        agent.id,
        body.market_id,
        body.client_order_id,
        idempotencyKey,
        body.side,
        body.outcome,
        body.price,
        body.size,
        takerUpdate.filled_size,
        takerUpdate.status,
        signedTimestamp,
        requestSignature,
        orderCreatedAt,
        orderCreatedAt,
      ],
    );

    await appendAcceptedOrderEvent(client, {
      order_id: orderId,
      agent_id: agent.id,
      market_id: body.market_id,
      side: body.side,
      outcome: body.outcome,
      price: body.price,
      size: body.size,
      created_at: orderCreatedAt,
    });

    for (const update of matchingResult.touched_orders) {
      if (update.order_id === orderId) {
        continue;
      }

      await client.query(
        `
          UPDATE orders
          SET
            filled_size = $2,
            status = $3,
            updated_at = NOW()
          WHERE id = $1
        `,
        [update.order_id, update.filled_size, update.status],
      );
    }

    await insertFillsAndUpdateMarketStats(client, matchingResult.fills);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  reply.code(202);
  return {
    order_id: orderId,
    client_order_id: body.client_order_id,
    status: matchingResult.status,
    received_at: new Date().toISOString(),
    filled_size: matchingResult.filled_size,
  };
});

app.post("/v1/orders/cancel", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const body = request.body as { order_id?: string; client_order_id?: string };
  if (!body.order_id && !body.client_order_id) {
    reply.code(400);
    return { error: "missing_order_identity" };
  }

  const result = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE agent_id = $1
        AND (id = $2 OR client_order_id = $3)
      LIMIT 1
    `,
    [agent.id, body.order_id ?? null, body.client_order_id ?? null],
  );

  if (!result.rowCount) {
    reply.code(404);
    return { status: "not_found" };
  }

  const order = result.rows[0];
  if (order.status === "canceled" || Number(order.filled_size) >= Number(order.size)) {
    return { status: "accepted" };
  }

  let canceledAtEngine = false;
  try {
    const cancelResult = await cancelAtMatchingEngine({
      order_id: order.id,
      market_id: order.market_id,
      side: order.side,
      outcome: order.outcome,
    });
    canceledAtEngine = cancelResult.canceled;
  } catch (error) {
    reply.code(502);
    return { error: String(error) };
  }

  if (!canceledAtEngine) {
    reply.code(409);
    return { error: "order_not_cancelable_in_matching_engine" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE orders
        SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [order.id],
    );
    await appendCanceledOrderEvent(client, order);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  reply.code(202);
  return { status: "accepted" };
});

app.get("/v1/orders/:orderId", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const { orderId } = request.params as { orderId: string };
  const result = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE id = $1 AND agent_id = $2
    `,
    [orderId, agent.id],
  );

  if (!result.rowCount) {
    reply.code(404);
    return { error: "order_not_found" };
  }

  const order = mapOrderRow(result.rows[0]);
  return {
    ...order,
    order_type: "limit",
  };
});

app.get("/v1/fills", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const result = await pool.query<FillRow>(
    `
      SELECT *
      FROM fills
      WHERE buy_agent_id = $1 OR sell_agent_id = $1
      ORDER BY executed_at DESC, id DESC
    `,
    [agent.id],
  );

  return {
    items: result.rows.map(mapFillRow),
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
