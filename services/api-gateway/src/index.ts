import Fastify from "fastify";

const port = Number(process.env.API_GATEWAY_PORT ?? 4000);
const app = Fastify({ logger: true });

app.get("/health", async () => ({
  service: "api-gateway",
  status: "ok",
}));

app.get("/", async () => ({
  name: "Agentic Polymarket API Gateway",
  routes: {
    authRegistry: "http://localhost:4002",
    marketService: "http://localhost:4003",
    agentGateway: "http://localhost:4001",
    proposalPipeline: "http://localhost:4005",
    resolutionService: "http://localhost:4006",
  },
  note: "Routing proxy is not implemented yet. This service currently anchors the edge boundary.",
}));

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
