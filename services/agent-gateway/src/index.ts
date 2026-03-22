import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import Fastify from "fastify";
import type { PoolClient } from "pg";
import { createDatabasePool, ensureCoreSchema, toIsoTimestamp } from "@automakit/persistence";

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

type OrderbookLevel = {
  price: number;
  size: number;
};

type OrderbookRow = {
  outcome: Outcome;
  side: Side;
  price: unknown;
  remaining_size: unknown;
};

type PortfolioPositionRow = {
  market_id: string;
  outcome: Outcome;
  quantity: unknown;
  reserved_quantity: unknown;
  cost_basis_notional: unknown;
  mark_price_yes: unknown;
  final_outcome: unknown;
};

type PortfolioSnapshot = {
  agent_id: string;
  cash_balance: number;
  reserved_balance: number;
  realized_pnl: number;
  unrealized_pnl: number;
  fees: number;
  payouts: number;
  positions: Array<{
    market_id: string;
    outcome: Outcome;
    quantity: number;
    reserved_quantity: number;
    average_price: number;
    mark_price: number;
    unrealized_pnl: number;
  }>;
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
const portfolioServiceUrl = process.env.PORTFOLIO_SERVICE_URL ?? "http://localhost:4004";
const matchingEngineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:7400";
const maxSignatureAgeMs = Number(process.env.AGENT_REQUEST_MAX_AGE_MS ?? 5 * 60_000);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

type Queryable = Pick<PoolClient, "query">;

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

async function getOrderbookSnapshot(client: Queryable, marketId: string) {
  const result = await client.query<OrderbookRow>(
    `
      SELECT
        outcome,
        side,
        price,
        SUM(GREATEST(size - filled_size, 0)) AS remaining_size
      FROM orders
      WHERE market_id = $1
        AND status IN ('open', 'partially_filled')
      GROUP BY outcome, side, price
    `,
    [marketId],
  );

  const snapshot = {
    market_id: marketId,
    yes_bids: [] as OrderbookLevel[],
    yes_asks: [] as OrderbookLevel[],
    no_bids: [] as OrderbookLevel[],
    no_asks: [] as OrderbookLevel[],
  };

  for (const row of result.rows) {
    const level = {
      price: Number(row.price),
      size: Number(row.remaining_size),
    };

    if (row.outcome === "YES" && row.side === "buy") {
      snapshot.yes_bids.push(level);
    } else if (row.outcome === "YES" && row.side === "sell") {
      snapshot.yes_asks.push(level);
    } else if (row.outcome === "NO" && row.side === "buy") {
      snapshot.no_bids.push(level);
    } else if (row.outcome === "NO" && row.side === "sell") {
      snapshot.no_asks.push(level);
    }
  }

  snapshot.yes_bids.sort((left, right) => right.price - left.price || right.size - left.size);
  snapshot.yes_asks.sort((left, right) => left.price - right.price || right.size - left.size);
  snapshot.no_bids.sort((left, right) => right.price - left.price || right.size - left.size);
  snapshot.no_asks.sort((left, right) => left.price - right.price || right.size - left.size);

  return snapshot;
}

async function getPortfolioSnapshot(client: Queryable, agentId: string): Promise<PortfolioSnapshot> {
  const [accountResult, positionsResult] = await Promise.all([
    client.query<{
      cash_balance: unknown;
      reserved_cash: unknown;
      realized_pnl: unknown;
      fees: unknown;
      payouts: unknown;
    }>(
      `
        SELECT cash_balance, reserved_cash, realized_pnl, fees, payouts
        FROM portfolio_accounts
        WHERE agent_id = $1
      `,
      [agentId],
    ),
    client.query<PortfolioPositionRow>(
      `
        SELECT
          p.market_id,
          p.outcome,
          p.quantity,
          p.reserved_quantity,
          p.cost_basis_notional,
          m.last_traded_price_yes AS mark_price_yes,
          rc.final_outcome
        FROM portfolio_positions p
        JOIN markets m ON m.id = p.market_id
        LEFT JOIN resolution_cases rc ON rc.market_id = p.market_id
        WHERE p.agent_id = $1
          AND p.quantity > 0
      `,
      [agentId],
    ),
  ]);

  const account = accountResult.rows[0];
  let unrealizedPnl = 0;
  const positions = positionsResult.rows.map((row) => {
    const quantity = Number(row.quantity);
    const costBasis = Number(row.cost_basis_notional);
    const averagePrice = quantity > 0 ? costBasis / quantity : 0;
    let markPriceYes = Number(row.mark_price_yes ?? 0);
    if (row.final_outcome === "YES") {
      markPriceYes = 1;
    } else if (row.final_outcome === "NO") {
      markPriceYes = 0;
    }
    const markPrice = row.outcome === "YES" ? markPriceYes : 1 - markPriceYes;
    const unrealized = quantity * (markPrice - averagePrice);
    unrealizedPnl += unrealized;

    return {
      market_id: row.market_id,
      outcome: row.outcome,
      quantity,
      reserved_quantity: Number(row.reserved_quantity),
      average_price: averagePrice,
      mark_price: markPrice,
      unrealized_pnl: unrealized,
    };
  });

  return {
    agent_id: agentId,
    cash_balance: Number(account?.cash_balance ?? 0),
    reserved_balance: Number(account?.reserved_cash ?? 0),
    realized_pnl: Number(account?.realized_pnl ?? 0),
    unrealized_pnl: unrealizedPnl,
    fees: Number(account?.fees ?? 0),
    payouts: Number(account?.payouts ?? 0),
    positions,
  };
}

async function appendStreamEvent(
  client: Queryable,
  event: {
    channel: string;
    market_id?: string | null;
    agent_id?: string | null;
    payload: unknown;
    created_at?: string;
  },
) {
  await client.query(
    `
      INSERT INTO stream_events (
        event_id,
        channel,
        market_id,
        agent_id,
        payload,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
    `,
    [
      randomUUID(),
      event.channel,
      event.market_id ?? null,
      event.agent_id ?? null,
      JSON.stringify(event.payload),
      event.created_at ?? new Date().toISOString(),
    ],
  );
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

async function reserveAtPortfolioService(body: {
  order_id: string;
  agent_id: string;
  market_id: string;
  side: Side;
  outcome: Outcome;
  price: number;
  size: number;
}) {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/orders/reserve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function settleAtPortfolioService(body: {
  fills: Array<{
    fill_id: string;
    market_id: string;
    outcome: Outcome;
    price: number;
    size: number;
    buy_order_id: string;
    sell_order_id: string;
    buy_agent_id: string;
    sell_agent_id: string;
    buy_limit_price: number;
    sell_limit_price: number;
    executed_at: string;
  }>;
}) {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/orders/settle`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function cancelAtPortfolioService(body: {
  order_id: string;
  agent_id: string;
  market_id: string;
  outcome: Outcome;
  side: Side;
  price: number;
  remaining_size: number;
}) {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/orders/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
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
  return getPortfolioSnapshot(pool, agent.id);
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
  const reserveResult = await reserveAtPortfolioService({
    order_id: orderId,
    agent_id: agent.id,
    market_id: body.market_id,
    side: body.side,
    outcome: body.outcome,
    price: body.price,
    size: body.size,
  });
  if (!reserveResult.ok) {
    reply.code(reserveResult.status);
    return reserveResult.body;
  }

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
    await cancelAtPortfolioService({
      order_id: orderId,
      agent_id: agent.id,
      market_id: body.market_id,
      outcome: body.outcome,
      side: body.side,
      price: body.price,
      remaining_size: body.size,
    }).catch(() => undefined);
    reply.code(502);
    return { error: String(error) };
  }

  const client = await pool.connect();
  const affectedAgentIds = new Set<string>([agent.id]);
  let settlementPayload: Array<{
    fill_id: string;
    market_id: string;
    outcome: Outcome;
    price: number;
    size: number;
    buy_order_id: string;
    sell_order_id: string;
    buy_agent_id: string;
    sell_agent_id: string;
    buy_limit_price: number;
    sell_limit_price: number;
    executed_at: string;
  }> = [];
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

    const touchedOrderIds = matchingResult.touched_orders.map((entry) => entry.order_id);
    const touchedOrdersResult = await client.query<OrderRow>(
      `
        SELECT *
        FROM orders
        WHERE id = ANY($1::text[])
      `,
      [touchedOrderIds],
    );

    const touchedOrders = touchedOrdersResult.rows.map(mapOrderRow);
    const orderPriceById = new Map<string, number>();
    for (const order of touchedOrders) {
      orderPriceById.set(order.id, order.price);
    }

    for (const order of touchedOrders) {
      await appendStreamEvent(client, {
        channel: "order.update",
        market_id: order.market_id,
        agent_id: order.agent_id,
        payload: order,
        created_at: order.updated_at,
      });
    }

    for (const fill of matchingResult.fills) {
      settlementPayload.push({
        fill_id: fill.fill_id,
        market_id: fill.market_id,
        outcome: fill.outcome,
        price: fill.price,
        size: fill.size,
        buy_order_id: fill.buy_order_id,
        sell_order_id: fill.sell_order_id,
        buy_agent_id: fill.buy_agent_id,
        sell_agent_id: fill.sell_agent_id,
        buy_limit_price: orderPriceById.get(fill.buy_order_id) ?? body.price,
        sell_limit_price: orderPriceById.get(fill.sell_order_id) ?? body.price,
        executed_at: fill.executed_at,
      });
      await appendStreamEvent(client, {
        channel: "trade.fill",
        market_id: fill.market_id,
        payload: {
          id: fill.fill_id,
          market_id: fill.market_id,
          outcome: fill.outcome,
          price: fill.price,
          size: fill.size,
          buy_order_id: fill.buy_order_id,
          sell_order_id: fill.sell_order_id,
          buy_agent_id: fill.buy_agent_id,
          sell_agent_id: fill.sell_agent_id,
          executed_at: fill.executed_at,
        },
        created_at: fill.executed_at,
      });
    }

    await appendStreamEvent(client, {
      channel: "orderbook.delta",
      market_id: body.market_id,
      payload: {
        ...(await getOrderbookSnapshot(client, body.market_id)),
        reason: "order_submit",
        touched_order_ids: touchedOrderIds,
      },
    });

    for (const order of touchedOrders) {
      affectedAgentIds.add(order.agent_id);
    }
    for (const fill of matchingResult.fills) {
      affectedAgentIds.add(fill.buy_agent_id);
      affectedAgentIds.add(fill.sell_agent_id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (settlementPayload.length > 0) {
    const settleResult = await settleAtPortfolioService({ fills: settlementPayload });
    if (!settleResult.ok) {
      reply.code(502);
      return { error: "portfolio_settlement_failed", details: settleResult.body };
    }
  }

  for (const affectedAgentId of affectedAgentIds) {
    await appendStreamEvent(pool, {
      channel: "portfolio.update",
      agent_id: affectedAgentId,
      market_id: body.market_id,
      payload: await getPortfolioSnapshot(pool, affectedAgentId),
    });
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
    const canceledOrderResult = await client.query<OrderRow>(
      `
        SELECT *
        FROM orders
        WHERE id = $1
      `,
      [order.id],
    );
    const canceledOrder = mapOrderRow(canceledOrderResult.rows[0]);
    await appendStreamEvent(client, {
      channel: "order.update",
      market_id: canceledOrder.market_id,
      agent_id: canceledOrder.agent_id,
      payload: canceledOrder,
      created_at: canceledOrder.updated_at,
    });
    await appendStreamEvent(client, {
      channel: "orderbook.delta",
      market_id: canceledOrder.market_id,
      payload: {
        ...(await getOrderbookSnapshot(client, canceledOrder.market_id)),
        reason: "order_cancel",
        touched_order_ids: [canceledOrder.id],
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const remainingSize = Math.max(Number(order.size) - Number(order.filled_size), 0);
  const portfolioCancelResult = await cancelAtPortfolioService({
    order_id: order.id,
    agent_id: order.agent_id,
    market_id: order.market_id,
    outcome: order.outcome,
    side: order.side,
    price: Number(order.price),
    remaining_size: remainingSize,
  });
  if (!portfolioCancelResult.ok) {
    reply.code(502);
    return { error: "portfolio_cancel_failed", details: portfolioCancelResult.body };
  }

  await appendStreamEvent(pool, {
    channel: "portfolio.update",
    market_id: order.market_id,
    agent_id: order.agent_id,
    payload: await getPortfolioSnapshot(pool, order.agent_id),
  });

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
