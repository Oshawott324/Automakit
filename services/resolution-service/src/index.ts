import { randomUUID } from "node:crypto";
import Fastify from "fastify";
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

const port = Number(process.env.RESOLUTION_SERVICE_PORT ?? 4006);
const app = Fastify({ logger: true });
const resolutionCases = new Map<string, ResolutionCase>();
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";
const quorumThreshold = Number(process.env.RESOLUTION_QUORUM_THRESHOLD ?? 2);

app.get("/health", async () => ({ service: "resolution-service", status: "ok" }));

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
    resolutionCases.get(marketId) ??
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

  resolutionCase.evidence.push(evidence);
  updateResolutionCaseState(resolutionCase);
  resolutionCases.set(marketId, resolutionCase);
  reply.code(201);
  return evidence;
});

app.get("/v1/resolutions", async () => ({
  items: [...resolutionCases.values()],
}));

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
