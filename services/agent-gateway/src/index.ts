import { randomUUID } from "node:crypto";
import Fastify from "fastify";

type OrderRecord = {
  id: string;
  market_id: string;
  client_order_id: string;
  side: "buy" | "sell";
  outcome: "YES" | "NO";
  price: number;
  size: number;
  status: "accepted" | "canceled";
};

const port = Number(process.env.AGENT_GATEWAY_PORT ?? 4001);
const app = Fastify({ logger: true });
const orders = new Map<string, OrderRecord>();
const idempotencyKeys = new Set<string>();

app.get("/health", async () => ({ service: "agent-gateway", status: "ok" }));

app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/health") {
    return;
  }

  const authorization = request.headers.authorization;
  if (!authorization) {
    reply.code(401);
    return reply.send({ error: "missing_authorization" });
  }
});

app.get("/v1/portfolio", async () => ({
  agent_id: "seed-agent",
  cash_balance: 100000,
  reserved_balance: 1500,
  realized_pnl: 250,
  unrealized_pnl: 420,
  positions: [
    {
      market_id: "btc-100k-jun",
      outcome: "YES",
      quantity: 500,
      average_price: 0.56,
      mark_price: 0.61,
    },
  ],
}));

app.post("/v1/orders", async (request, reply) => {
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string") {
    reply.code(400);
    return { error: "missing_idempotency_key" };
  }
  if (idempotencyKeys.has(idempotencyKey)) {
    reply.code(409);
    return { error: "duplicate_idempotency_key" };
  }

  const body = request.body as {
    market_id: string;
    side: "buy" | "sell";
    outcome: "YES" | "NO";
    price: number;
    size: number;
    client_order_id: string;
  };

  const order: OrderRecord = {
    id: randomUUID(),
    market_id: body.market_id,
    client_order_id: body.client_order_id,
    side: body.side,
    outcome: body.outcome,
    price: body.price,
    size: body.size,
    status: "accepted",
  };

  orders.set(order.id, order);
  idempotencyKeys.add(idempotencyKey);
  reply.code(202);
  return {
    order_id: order.id,
    client_order_id: order.client_order_id,
    status: "accepted",
    received_at: new Date().toISOString(),
  };
});

app.post("/v1/orders/cancel", async (request, reply) => {
  const body = request.body as { order_id?: string; client_order_id?: string };
  const order = [...orders.values()].find(
    (entry) => entry.id === body.order_id || entry.client_order_id === body.client_order_id,
  );

  if (!order) {
    reply.code(404);
    return { status: "not_found" };
  }

  order.status = "canceled";
  reply.code(202);
  return { status: "accepted" };
});

app.get("/v1/orders/:orderId", async (request, reply) => {
  const orderId = (request.params as { orderId: string }).orderId;
  const order = orders.get(orderId);
  if (!order) {
    reply.code(404);
    return { error: "order_not_found" };
  }
  return {
    ...order,
    order_type: "limit",
    filled_size: 0,
    created_at: new Date().toISOString(),
  };
});

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
