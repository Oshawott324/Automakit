import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  createDatabasePool,
  ensureCoreSchema,
  parseJsonField,
  toIsoTimestamp,
} from "@agentic-polymarket/persistence";
import type { ResolutionKind, ResolutionMetadata } from "@agentic-polymarket/sdk-types";

type Outcome = "YES" | "NO" | "CANCELED";
type ResolutionStatus = "pending_evidence" | "finalizing" | "finalized" | "quarantined";
type ObservationPayload = Record<string, string | number | boolean | null>;

type MarketResolutionDefinition = {
  resolution_source: string;
  resolution_kind: ResolutionKind;
  resolution_metadata: ResolutionMetadata;
};

type ResolutionEvidence = {
  id: string;
  market_id: string;
  submitter_agent_id: string;
  evidence_type: "url" | "text" | "file";
  derived_outcome: Outcome;
  summary: string;
  source_url: string;
  observed_at: string;
  observation_payload: ObservationPayload;
  created_at: string;
};

type ResolutionCase = {
  market_id: string;
  status: ResolutionStatus;
  draft_outcome: Outcome | null;
  final_outcome: Outcome | null;
  canonical_source_url: string | null;
  evidence: ResolutionEvidence[];
  quorum_threshold: number;
  last_updated_at: string;
};

type ResolutionCaseRow = {
  market_id: string;
  status: ResolutionStatus;
  draft_outcome: Outcome | null;
  final_outcome: Outcome | null;
  canonical_source_url: string | null;
  quorum_threshold: number;
  last_updated_at: unknown;
};

type ResolutionEvidenceRow = {
  id: string;
  market_id: string;
  submitter_agent_id: string;
  evidence_type: "url" | "text" | "file";
  derived_outcome: Outcome;
  summary: string;
  source_url: string;
  observed_at: unknown;
  observation_payload: unknown;
  created_at: unknown;
};

const port = Number(process.env.RESOLUTION_SERVICE_PORT ?? 4006);
const app = Fastify({ logger: true });
const pool = createDatabasePool();
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";
const quorumThreshold = Number(process.env.RESOLUTION_QUORUM_THRESHOLD ?? 2);

async function appendStreamEvent(event: {
  market_id: string;
  payload: unknown;
  created_at?: string;
}) {
  await pool.query(
    `
      INSERT INTO stream_events (
        event_id,
        channel,
        market_id,
        agent_id,
        payload,
        created_at
      )
      VALUES ($1, 'resolution.update', $2, NULL, $3::jsonb, $4::timestamptz)
    `,
    [
      randomUUID(),
      event.market_id,
      JSON.stringify(event.payload),
      event.created_at ?? new Date().toISOString(),
    ],
  );
}

function mapResolutionEvidenceRow(row: ResolutionEvidenceRow): ResolutionEvidence {
  return {
    id: row.id,
    market_id: row.market_id,
    submitter_agent_id: row.submitter_agent_id,
    evidence_type: row.evidence_type,
    derived_outcome: row.derived_outcome,
    summary: row.summary,
    source_url: row.source_url,
    observed_at: toIsoTimestamp(row.observed_at),
    observation_payload: parseJsonField<ObservationPayload>(row.observation_payload),
    created_at: toIsoTimestamp(row.created_at),
  };
}

function normalizeHostname(url: string) {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

function isAllowedSource(candidateUrl: string, canonicalUrl: string) {
  const canonicalHost = normalizeHostname(canonicalUrl);
  const candidateHost = normalizeHostname(candidateUrl);
  return candidateHost === canonicalHost || candidateHost.endsWith(`.${canonicalHost}`);
}

async function fetchMarketResolutionDefinition(marketId: string): Promise<MarketResolutionDefinition> {
  const response = await fetch(`${marketServiceUrl}/v1/markets/${marketId}`);
  if (!response.ok) {
    throw new Error(`market lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    resolution_source?: string;
    resolution_kind?: ResolutionKind;
    resolution_metadata?: ResolutionMetadata;
  };
  if (!payload.resolution_source || !payload.resolution_kind || !payload.resolution_metadata) {
    throw new Error("market resolution source missing");
  }

  return {
    resolution_source: payload.resolution_source,
    resolution_kind: payload.resolution_kind,
    resolution_metadata: payload.resolution_metadata,
  };
}

function readNumericObservation(payload: ObservationPayload, key: string) {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function deriveOutcomeFromObservation(
  definition: MarketResolutionDefinition,
  observationPayload: ObservationPayload,
): Outcome | null {
  if (definition.resolution_kind === "price_threshold") {
    const metadata = definition.resolution_metadata;
    if (metadata.kind !== "price_threshold") {
      return null;
    }

    const observedPrice = readNumericObservation(observationPayload, "price");
    if (observedPrice === null) {
      return null;
    }

    switch (metadata.operator) {
      case "gt":
        return observedPrice > metadata.threshold ? "YES" : "NO";
      case "gte":
        return observedPrice >= metadata.threshold ? "YES" : "NO";
      case "lt":
        return observedPrice < metadata.threshold ? "YES" : "NO";
      case "lte":
        return observedPrice <= metadata.threshold ? "YES" : "NO";
      default:
        return null;
    }
  }

  if (definition.resolution_kind === "rate_decision") {
    const metadata = definition.resolution_metadata;
    if (metadata.kind !== "rate_decision") {
      return null;
    }

    const previousUpperBound = readNumericObservation(observationPayload, "previous_upper_bound_bps");
    const currentUpperBound = readNumericObservation(observationPayload, "current_upper_bound_bps");
    if (previousUpperBound === null || currentUpperBound === null) {
      return null;
    }

    switch (metadata.direction) {
      case "cut":
        return currentUpperBound < previousUpperBound ? "YES" : "NO";
      case "hold":
        return currentUpperBound === previousUpperBound ? "YES" : "NO";
      case "hike":
        return currentUpperBound > previousUpperBound ? "YES" : "NO";
      default:
        return null;
    }
  }

  return null;
}

async function getResolutionEvidence(marketId: string) {
  const result = await pool.query<ResolutionEvidenceRow>(
    `
      SELECT *
      FROM resolution_evidence
      WHERE market_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [marketId],
  );

  return result.rows.map(mapResolutionEvidenceRow);
}

async function getResolutionCase(marketId: string): Promise<ResolutionCase | null> {
  const result = await pool.query<ResolutionCaseRow>(
    `
      SELECT *
      FROM resolution_cases
      WHERE market_id = $1
    `,
    [marketId],
  );

  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0];
  return {
    market_id: row.market_id,
    status: row.status,
    draft_outcome: row.draft_outcome,
    final_outcome: row.final_outcome,
    canonical_source_url: row.canonical_source_url,
    evidence: await getResolutionEvidence(row.market_id),
    quorum_threshold: Number(row.quorum_threshold),
    last_updated_at: toIsoTimestamp(row.last_updated_at),
  };
}

async function saveResolutionCase(resolutionCase: ResolutionCase) {
  await pool.query(
    `
      INSERT INTO resolution_cases (
        market_id,
        status,
        draft_outcome,
        final_outcome,
        canonical_source_url,
        quorum_threshold,
        last_updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
      ON CONFLICT (market_id) DO UPDATE SET
        status = EXCLUDED.status,
        draft_outcome = EXCLUDED.draft_outcome,
        final_outcome = EXCLUDED.final_outcome,
        canonical_source_url = EXCLUDED.canonical_source_url,
        quorum_threshold = EXCLUDED.quorum_threshold,
        last_updated_at = EXCLUDED.last_updated_at
    `,
    [
      resolutionCase.market_id,
      resolutionCase.status,
      resolutionCase.draft_outcome,
      resolutionCase.final_outcome,
      resolutionCase.canonical_source_url,
      resolutionCase.quorum_threshold,
      resolutionCase.last_updated_at,
    ],
  );
}

function updateResolutionCaseState(resolutionCase: ResolutionCase) {
  const evidenceCount = resolutionCase.evidence.length;
  if (evidenceCount === 0) {
    resolutionCase.status = "pending_evidence";
    resolutionCase.draft_outcome = null;
    resolutionCase.final_outcome = null;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  const counts = new Map<Outcome, number>();
  for (const evidence of resolutionCase.evidence) {
    counts.set(evidence.derived_outcome, (counts.get(evidence.derived_outcome) ?? 0) + 1);
  }

  if (counts.size > 1) {
    resolutionCase.status = "quarantined";
    resolutionCase.draft_outcome = null;
    resolutionCase.final_outcome = null;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  const [[outcome, count]] = [...counts.entries()];
  resolutionCase.draft_outcome = outcome;

  if (count >= resolutionCase.quorum_threshold) {
    resolutionCase.status = "finalized";
    resolutionCase.final_outcome = outcome;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  resolutionCase.status = "finalizing";
  resolutionCase.final_outcome = null;
  resolutionCase.last_updated_at = new Date().toISOString();
}

app.get("/health", async () => ({ service: "resolution-service", status: "ok" }));

app.post("/v1/resolution-evidence", async (request, reply) => {
  const body = request.body as {
    market_id?: string;
    evidence_type?: "url" | "text" | "file";
    summary?: string;
    source_url?: string;
    observed_at?: string;
    observation_payload?: ObservationPayload;
  };
  const submitterAgentId = request.headers["x-agent-id"];
  if (typeof submitterAgentId !== "string" || submitterAgentId.length === 0) {
    reply.code(400);
    return { error: "missing_agent_identity" };
  }

  const marketId = body.market_id ?? "unknown-market";
  if (!body.source_url || !body.observed_at || !body.summary || !body.observation_payload) {
    reply.code(400);
    return { error: "invalid_resolution_evidence" };
  }

  let definition: MarketResolutionDefinition;
  try {
    definition = await fetchMarketResolutionDefinition(marketId);
  } catch (error) {
    reply.code(404);
    return { error: `unknown_market_resolution_source:${String(error)}` };
  }

  try {
    if (!isAllowedSource(body.source_url, definition.resolution_source)) {
      reply.code(422);
      return { error: "source_url_not_allowed_for_market" };
    }
  } catch {
    reply.code(400);
    return { error: "invalid_source_url" };
  }

  const derivedOutcome = deriveOutcomeFromObservation(definition, body.observation_payload);
  if (!derivedOutcome) {
    reply.code(422);
    return { error: "evidence_not_parseable_for_market_kind" };
  }

  const resolutionCase =
    (await getResolutionCase(marketId)) ??
    {
      market_id: marketId,
      status: "pending_evidence",
      draft_outcome: null,
      final_outcome: null,
      canonical_source_url: definition.resolution_source,
      evidence: [],
      quorum_threshold: quorumThreshold,
      last_updated_at: new Date().toISOString(),
    };

  if (resolutionCase.status === "finalized") {
    reply.code(409);
    return { error: "resolution_case_already_finalized" };
  }

  const duplicateAgentEvidence = resolutionCase.evidence.find(
    (entry) => entry.submitter_agent_id === submitterAgentId,
  );
  if (duplicateAgentEvidence) {
    reply.code(409);
    return { error: "duplicate_resolver_agent" };
  }

  const evidence: ResolutionEvidence = {
    id: randomUUID(),
    market_id: marketId,
    submitter_agent_id: submitterAgentId,
    evidence_type: body.evidence_type ?? "text",
    derived_outcome: derivedOutcome,
    summary: body.summary,
    source_url: body.source_url,
    observed_at: body.observed_at,
    observation_payload: body.observation_payload,
    created_at: new Date().toISOString(),
  };

  await saveResolutionCase(resolutionCase);
  await pool.query(
    `
      INSERT INTO resolution_evidence (
        id,
        market_id,
        submitter_agent_id,
        evidence_type,
        derived_outcome,
        summary,
        source_url,
        observed_at,
        observation_payload,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10::timestamptz)
    `,
    [
      evidence.id,
      evidence.market_id,
      evidence.submitter_agent_id,
      evidence.evidence_type,
      evidence.derived_outcome,
      evidence.summary,
      evidence.source_url,
      evidence.observed_at,
      JSON.stringify(evidence.observation_payload),
      evidence.created_at,
    ],
  );

  resolutionCase.evidence = await getResolutionEvidence(marketId);
  updateResolutionCaseState(resolutionCase);
  await saveResolutionCase(resolutionCase);
  await appendStreamEvent({
    market_id: marketId,
    payload: {
      market_id: resolutionCase.market_id,
      status: resolutionCase.status,
      draft_outcome: resolutionCase.draft_outcome,
      final_outcome: resolutionCase.final_outcome,
      canonical_source_url: resolutionCase.canonical_source_url,
      evidence: resolutionCase.evidence,
      quorum_threshold: resolutionCase.quorum_threshold,
      last_updated_at: resolutionCase.last_updated_at,
    },
    created_at: resolutionCase.last_updated_at,
  });
  reply.code(201);
  return evidence;
});

app.get("/v1/resolutions", async () => {
  const result = await pool.query<ResolutionCaseRow>(
    `
      SELECT *
      FROM resolution_cases
      ORDER BY last_updated_at DESC, market_id ASC
    `,
  );

  const items = await Promise.all(
    result.rows.map(async (row) => ({
      market_id: row.market_id,
      status: row.status,
      draft_outcome: row.draft_outcome,
      final_outcome: row.final_outcome,
      canonical_source_url: row.canonical_source_url,
      evidence: await getResolutionEvidence(row.market_id),
      quorum_threshold: Number(row.quorum_threshold),
      last_updated_at: toIsoTimestamp(row.last_updated_at),
    })),
  );

  return { items };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
