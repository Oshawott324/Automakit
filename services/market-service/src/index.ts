import Fastify from "fastify";
import {
  createDatabasePool,
  ensureCoreSchema,
  parseJsonField,
  toIsoTimestamp,
  toNumberOrNull,
} from "@agentic-polymarket/persistence";
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

type MarketRow = {
  id: string;
  proposal_id: string;
  event_id: string;
  title: string;
  subtitle: string | null;
  status: MarketRecord["status"];
  category: string;
  close_time: unknown;
  resolution_source: string;
  resolution_kind: ResolutionKind;
  resolution_metadata: unknown;
  last_traded_price_yes: unknown;
  volume_24h: unknown;
  liquidity_score: unknown;
  outcomes: unknown;
  rules: string;
};

const port = Number(process.env.MARKET_SERVICE_PORT ?? 4003);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

function mapMarketRow(row: MarketRow): MarketRecord {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    event_id: row.event_id,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    category: row.category,
    close_time: toIsoTimestamp(row.close_time),
    resolution_source: row.resolution_source,
    resolution_kind: row.resolution_kind,
    resolution_metadata: parseJsonField<ResolutionMetadata>(row.resolution_metadata),
    last_traded_price_yes: toNumberOrNull(row.last_traded_price_yes),
    volume_24h: Number(row.volume_24h),
    liquidity_score: Number(row.liquidity_score),
    outcomes: parseJsonField<["YES", "NO"]>(row.outcomes),
    rules: row.rules,
  };
}

app.get("/health", async () => ({ service: "market-service", status: "ok" }));

app.get("/v1/markets", async () => {
  const result = await pool.query<MarketRow>(
    `
      SELECT
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
      FROM markets
      ORDER BY close_time ASC, id ASC
    `,
  );

  return {
    items: result.rows.map(({ rules, ...market }) => mapMarketRow({ ...market, rules })),
    next_cursor: null,
  };
});

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

  const existing = await pool.query<MarketRow>(
    `
      SELECT
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
      FROM markets
      WHERE proposal_id = $1
    `,
    [body.proposal_id],
  );

  if (existing.rowCount) {
    return mapMarketRow(existing.rows[0]);
  }

  const inserted = await pool.query<MarketRow>(
    `
      INSERT INTO markets (
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11::jsonb, $12, $13, $14, $15::jsonb, $16
      )
      RETURNING
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
    `,
    [
      body.proposal_id,
      body.proposal_id,
      `evt-${body.proposal_id}`,
      body.title,
      null,
      "open",
      body.category ?? "uncategorized",
      body.close_time,
      body.source_of_truth_url,
      body.resolution_kind,
      JSON.stringify(body.resolution_metadata),
      null,
      0,
      0,
      JSON.stringify(["YES", "NO"]),
      body.resolution_criteria,
    ],
  );

  reply.code(201);
  return mapMarketRow(inserted.rows[0]);
});

app.get("/v1/markets/:marketId", async (request, reply) => {
  const marketId = (request.params as { marketId: string }).marketId;
  const result = await pool.query<MarketRow>(
    `
      SELECT
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
      FROM markets
      WHERE id = $1
    `,
    [marketId],
  );

  if (!result.rowCount) {
    reply.code(404);
    return { error: "market_not_found" };
  }

  const market = mapMarketRow(result.rows[0]);

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

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
