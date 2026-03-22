import Fastify from "fastify";
import type { ResolutionKind, ResolutionMetadata } from "@agentic-polymarket/sdk-types";

type MarketRecord = {
  id: string;
  proposal_id: string;
  event_id: string;
  title: string;
  subtitle: string | null;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  category: string;
  close_time: string;
  resolution_source: string;
  resolution_kind: ResolutionKind;
  resolution_metadata: ResolutionMetadata;
  last_traded_price_yes: number | null;
  volume_24h: number;
  liquidity_score: number;
  outcomes: ["YES", "NO"];
  rules: string;
};

const port = Number(process.env.MARKET_SERVICE_PORT ?? 4003);
const app = Fastify({ logger: true });
const markets = new Map<string, MarketRecord>();
const marketsByProposalId = new Map<string, MarketRecord>();

app.get("/health", async () => ({ service: "market-service", status: "ok" }));

app.get("/v1/markets", async () => ({
  items: [...markets.values()].map(({ rules, ...market }) => market),
  next_cursor: null,
}));

app.post("/v1/internal/markets", async (request, reply) => {
  const body = request.body as {
    proposal_id?: string;
    title?: string;
    category?: string;
    close_time?: string;
    resolution_criteria?: string;
    source_of_truth_url?: string;
    resolution_kind?: ResolutionKind;
    resolution_metadata?: ResolutionMetadata;
  };

  if (
    !body.proposal_id ||
    !body.title ||
    !body.close_time ||
    !body.resolution_criteria ||
    !body.source_of_truth_url ||
    !body.resolution_kind ||
    !body.resolution_metadata
  ) {
    reply.code(400);
    return { error: "invalid_market_creation_request" };
  }

  const existing = marketsByProposalId.get(body.proposal_id);
  if (existing) {
    return existing;
  }

  const market: MarketRecord = {
    id: body.proposal_id,
    proposal_id: body.proposal_id,
    event_id: `evt-${body.proposal_id}`,
    title: body.title,
    subtitle: null,
    status: "open",
    category: body.category ?? "uncategorized",
    close_time: body.close_time,
    resolution_source: body.source_of_truth_url,
    resolution_kind: body.resolution_kind,
    resolution_metadata: body.resolution_metadata,
    last_traded_price_yes: null,
    volume_24h: 0,
    liquidity_score: 0,
    outcomes: ["YES", "NO"],
    rules: body.resolution_criteria,
  };

  markets.set(market.id, market);
  marketsByProposalId.set(market.proposal_id, market);
  reply.code(201);
  return market;
});

app.get("/v1/markets/:marketId", async (request, reply) => {
  const marketId = (request.params as { marketId: string }).marketId;
  const market = markets.get(marketId);

  if (!market) {
    reply.code(404);
    return { error: "market_not_found" };
  }

  return {
    ...market,
    source_of_truth_label: "Official source",
    event: {
      id: market.event_id,
      title: market.title,
      category: market.category,
      slug: market.id,
    },
    orderbook: {
      yes_bids: [],
      yes_asks: [],
      no_bids: [],
      no_asks: [],
    },
  };
});

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
