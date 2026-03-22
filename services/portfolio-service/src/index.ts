import Fastify from "fastify";

const port = Number(process.env.PORTFOLIO_SERVICE_PORT ?? 4004);
const app = Fastify({ logger: true });

app.get("/health", async () => ({ service: "portfolio-service", status: "ok" }));

app.get("/v1/internal/portfolios/:agentId", async (request) => {
  const agentId = (request.params as { agentId: string }).agentId;
  return {
    agent_id: agentId,
    cash_balance: 100000,
    reserved_balance: 1500,
    realized_pnl: 250,
    unrealized_pnl: 420,
    note: "Internal portfolio service placeholder.",
  };
});

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
