import { randomUUID } from "node:crypto";
import Fastify from "fastify";

type Outcome = "YES" | "NO" | "CANCELED";

type ResolutionCase = {
  market_id: string;
  status: "pending_evidence" | "finalizing" | "finalized" | "quarantined";
  draft_outcome: Outcome | null;
  final_outcome: Outcome | null;
  evidence: Array<{
    id: string;
    market_id: string;
    submitter_agent_id: string;
    evidence_type: string;
    summary: string;
    created_at: string;
  }>;
};

const port = Number(process.env.RESOLUTION_SERVICE_PORT ?? 4006);
const app = Fastify({ logger: true });
const resolutionCases = new Map<string, ResolutionCase>();

app.get("/health", async () => ({ service: "resolution-service", status: "ok" }));

function inferOutcome(summary: string): Outcome | null {
  if (/\b(cancel|canceled|cancelled)\b/i.test(summary)) {
    return "CANCELED";
  }
  if (/\b(resolve(s|d)?|outcome)\s+yes\b/i.test(summary) || /\byes\b/i.test(summary)) {
    return "YES";
  }
  if (/\b(resolve(s|d)?|outcome)\s+no\b/i.test(summary) || /\bno\b/i.test(summary)) {
    return "NO";
  }
  return null;
}

function updateResolutionCaseState(resolutionCase: ResolutionCase) {
  const inferredOutcomes = new Set(
    resolutionCase.evidence.map((entry) => inferOutcome(entry.summary)).filter(Boolean) as Outcome[],
  );

  if (inferredOutcomes.size === 0) {
    resolutionCase.status = "pending_evidence";
    resolutionCase.draft_outcome = null;
    resolutionCase.final_outcome = null;
    return;
  }

  if (inferredOutcomes.size > 1) {
    resolutionCase.status = "quarantined";
    resolutionCase.draft_outcome = null;
    resolutionCase.final_outcome = null;
    return;
  }

  const [outcome] = [...inferredOutcomes];
  resolutionCase.status = "finalized";
  resolutionCase.draft_outcome = outcome;
  resolutionCase.final_outcome = outcome;
}

app.post("/v1/resolution-evidence", async (request, reply) => {
  const body = request.body as {
    market_id?: string;
    evidence_type?: string;
    summary?: string;
  };
  const marketId = body.market_id ?? "unknown-market";
  const resolutionCase =
    resolutionCases.get(marketId) ??
    {
      market_id: marketId,
      status: "pending_evidence",
      draft_outcome: null,
      final_outcome: null,
      evidence: [],
    };

  const evidence = {
    id: randomUUID(),
    market_id: marketId,
    submitter_agent_id: "seed-agent",
    evidence_type: body.evidence_type ?? "text",
    summary: body.summary ?? "No summary provided.",
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
