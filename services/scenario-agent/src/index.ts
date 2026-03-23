import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import {
  type BeliefHypothesisProposal,
  type ScenarioPathHypothesis,
  type ScenarioPathProposal,
  type SimulationRunStatus,
  type WorldStateProposal,
  validateScenarioPathProposal,
} from "@automakit/world-sim";

type SimulationRunRow = {
  id: string;
  status: SimulationRunStatus;
  started_at: unknown;
};

type WorldStateProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  source_signal_ids: unknown;
  as_of: unknown;
  entities: unknown;
  active_events: unknown;
  factors: unknown;
  regime_labels: unknown;
  reasoning_summary: string;
  created_at: unknown;
};

type BeliefHypothesisProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  parent_ids: unknown;
  hypothesis_kind: BeliefHypothesisProposal["hypothesis_kind"];
  category: string;
  subject: string;
  predicate: string;
  target_time: unknown;
  confidence_score: unknown;
  reasoning_summary: string;
  source_signal_ids: unknown;
  machine_resolvable: boolean;
  suggested_resolution_spec: unknown;
  dedupe_key: string;
  created_at: unknown;
};

type ScenarioPathProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  label: string;
  probability: unknown;
  narrative: string;
  factor_deltas: unknown;
  path_events: unknown;
  path_hypotheses: unknown;
  created_at: unknown;
};

const port = Number(process.env.SCENARIO_AGENT_PORT ?? 4014);
const intervalMs = Number(process.env.SCENARIO_AGENT_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.SCENARIO_AGENT_BATCH_SIZE ?? 10);
const agentId = process.env.SCENARIO_AGENT_ID ?? "scenario-base";
const label = process.env.SCENARIO_LABEL ?? "base";
const configuredProbability = Number(process.env.SCENARIO_PROBABILITY ?? "0.5");
const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function mapWorldStateProposalRow(row: WorldStateProposalRow): WorldStateProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    source_signal_ids: parseJsonField<string[]>(row.source_signal_ids),
    as_of: toIsoTimestamp(row.as_of),
    entities: parseJsonField(row.entities),
    active_events: parseJsonField(row.active_events),
    factors: parseJsonField(row.factors),
    regime_labels: parseJsonField(row.regime_labels),
    reasoning_summary: row.reasoning_summary,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapBeliefRow(row: BeliefHypothesisProposalRow): BeliefHypothesisProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    parent_ids: parseJsonField<string[]>(row.parent_ids),
    hypothesis_kind: row.hypothesis_kind,
    category: row.category,
    subject: row.subject,
    predicate: row.predicate,
    target_time: toIsoTimestamp(row.target_time),
    confidence_score: Number(row.confidence_score),
    reasoning_summary: row.reasoning_summary,
    source_signal_ids: parseJsonField<string[]>(row.source_signal_ids),
    machine_resolvable: Boolean(row.machine_resolvable),
    suggested_resolution_spec: row.suggested_resolution_spec
      ? parseJsonField(row.suggested_resolution_spec)
      : undefined,
    dedupe_key: row.dedupe_key,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapScenarioRow(row: ScenarioPathProposalRow): ScenarioPathProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    label: row.label,
    probability: Number(row.probability),
    narrative: row.narrative,
    factor_deltas: parseJsonField(row.factor_deltas),
    path_events: parseJsonField(row.path_events),
    path_hypotheses: parseJsonField(row.path_hypotheses),
    created_at: toIsoTimestamp(row.created_at),
  };
}

async function fetchRuns(limit: number) {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT id, status, started_at
      FROM simulation_runs
      WHERE status = 'scenario_pending'
        AND NOT EXISTS (
          SELECT 1
          FROM scenario_path_proposals
          WHERE scenario_path_proposals.run_id = simulation_runs.id
            AND scenario_path_proposals.agent_id = $1
        )
      ORDER BY started_at ASC, id ASC
      LIMIT $2
    `,
    [agentId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    started_at: toIsoTimestamp(row.started_at),
  }));
}

async function fetchWorldStateProposals(runId: string) {
  const result = await pool.query<WorldStateProposalRow>(
    `
      SELECT *
      FROM world_state_proposals
      WHERE run_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [runId],
  );
  return result.rows.map(mapWorldStateProposalRow);
}

async function fetchDirectHypotheses(runId: string) {
  const result = await pool.query<BeliefHypothesisProposalRow>(
    `
      SELECT *
      FROM belief_hypothesis_proposals
      WHERE run_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [runId],
  );

  return result.rows.map(mapBeliefRow);
}

function clamp(value: number, min = 0.05, max = 0.95) {
  return Math.max(min, Math.min(max, value));
}

function scenarioAdjustedConfidence(kind: BeliefHypothesisProposal["hypothesis_kind"], base: number) {
  if (label === "bull") {
    return clamp(base + (kind === "price_threshold" ? 0.14 : 0.05));
  }
  if (label === "bear") {
    return clamp(base - (kind === "price_threshold" ? 0.2 : 0.08));
  }
  if (label === "stress") {
    return clamp(base - (kind === "price_threshold" ? 0.28 : 0.02));
  }
  return clamp(base - 0.02);
}

function deriveNarrative(worldStates: WorldStateProposal[]) {
  const labels = unique(worldStates.flatMap((proposal) => proposal.regime_labels));
  if (label === "bull") {
    return `Bull path with supportive market conditions across ${labels.join(", ") || "mixed regimes"}.`;
  }
  if (label === "bear") {
    return `Bear path with downside pressure and defensive positioning across ${labels.join(", ") || "mixed regimes"}.`;
  }
  if (label === "stress") {
    return `Stress path with elevated uncertainty across ${labels.join(", ") || "mixed regimes"}.`;
  }
  return `Base path with balanced progression across ${labels.join(", ") || "mixed regimes"}.`;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function aggregateDirectHypotheses(directHypotheses: BeliefHypothesisProposal[]) {
  const aggregates = new Map<
    string,
    {
      base: BeliefHypothesisProposal;
      totalConfidence: number;
      count: number;
      reasoning: string[];
      sourceSignalIds: Set<string>;
    }
  >();

  for (const hypothesis of directHypotheses) {
    const existing = aggregates.get(hypothesis.dedupe_key);
    if (existing) {
      existing.totalConfidence += hypothesis.confidence_score;
      existing.count += 1;
      existing.reasoning.push(hypothesis.reasoning_summary);
      for (const sourceSignalId of hypothesis.source_signal_ids) {
        existing.sourceSignalIds.add(sourceSignalId);
      }
      if (hypothesis.confidence_score > existing.base.confidence_score) {
        existing.base = hypothesis;
      }
      continue;
    }

    aggregates.set(hypothesis.dedupe_key, {
      base: hypothesis,
      totalConfidence: hypothesis.confidence_score,
      count: 1,
      reasoning: [hypothesis.reasoning_summary],
      sourceSignalIds: new Set(hypothesis.source_signal_ids),
    });
  }

  return [...aggregates.entries()].map(([key, aggregate]) => ({
    key,
    base: aggregate.base,
    averageConfidence: aggregate.totalConfidence / aggregate.count,
    count: aggregate.count,
    reasoningSummary: aggregate.reasoning.join(" "),
    sourceSignalIds: [...aggregate.sourceSignalIds],
  }));
}

function buildScenarioProposal(
  runId: string,
  worldStates: WorldStateProposal[],
  directHypotheses: BeliefHypothesisProposal[],
) {
  const pathHypotheses: ScenarioPathHypothesis[] = aggregateDirectHypotheses(directHypotheses).map((aggregate) => ({
    key: aggregate.key,
    hypothesis_kind: aggregate.base.hypothesis_kind,
    category: aggregate.base.category,
    subject: aggregate.base.subject,
    predicate: aggregate.base.predicate,
    target_time: aggregate.base.target_time,
    confidence_score: scenarioAdjustedConfidence(aggregate.base.hypothesis_kind, aggregate.averageConfidence),
    reasoning_summary: `${agentId} ran the ${label} path for ${aggregate.base.subject} after aggregating ${aggregate.count} world-model outputs. ${aggregate.reasoningSummary}`,
    source_signal_ids: aggregate.sourceSignalIds,
    machine_resolvable: aggregate.base.machine_resolvable,
    suggested_resolution_spec: aggregate.base.suggested_resolution_spec,
  }));

  const factorDeltas = {
    scenario_label: label,
    shock_bias:
      label === "bull" ? "positive" : label === "bear" || label === "stress" ? "negative" : "balanced",
    world_state_count: worldStates.length,
  };

  const pathEvents = [
    {
      id: randomUUID(),
      title: `${label} path launched`,
      event_type: "scenario_path",
      description: deriveNarrative(worldStates),
      effective_at: new Date().toISOString(),
    },
  ];

  const proposal: ScenarioPathProposal = {
    id: randomUUID(),
    run_id: runId,
    agent_id: agentId,
    label,
    probability: clamp(configuredProbability, 0.05, 0.95),
    narrative: deriveNarrative(worldStates),
    factor_deltas: factorDeltas,
    path_events: pathEvents,
    path_hypotheses: pathHypotheses,
    created_at: new Date().toISOString(),
  };

  const validation = validateScenarioPathProposal(proposal);
  if (!validation.ok) {
    throw new Error(`invalid_scenario_path_proposal:${validation.errors.join(",")}`);
  }

  return validation.proposal;
}

async function upsertScenarioProposal(proposal: ScenarioPathProposal) {
  await pool.query(
    `
      INSERT INTO scenario_path_proposals (
        id,
        run_id,
        agent_id,
        label,
        probability,
        narrative,
        factor_deltas,
        path_events,
        path_hypotheses,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz
      )
      ON CONFLICT (run_id, agent_id) DO UPDATE SET
        label = EXCLUDED.label,
        probability = EXCLUDED.probability,
        narrative = EXCLUDED.narrative,
        factor_deltas = EXCLUDED.factor_deltas,
        path_events = EXCLUDED.path_events,
        path_hypotheses = EXCLUDED.path_hypotheses
    `,
    [
      proposal.id,
      proposal.run_id,
      proposal.agent_id,
      proposal.label,
      proposal.probability,
      proposal.narrative,
      JSON.stringify(proposal.factor_deltas),
      JSON.stringify(proposal.path_events),
      JSON.stringify(proposal.path_hypotheses),
      proposal.created_at,
    ],
  );
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const runs = await fetchRuns(batchSize);
    for (const run of runs) {
      const worldStates = await fetchWorldStateProposals(run.id);
      const directHypotheses = await fetchDirectHypotheses(run.id);
      if (worldStates.length === 0 || directHypotheses.length === 0) {
        continue;
      }

      const proposal = buildScenarioProposal(run.id, worldStates, directHypotheses);
      await upsertScenarioProposal(proposal);
    }
    lastTickAt = new Date().toISOString();
    lastTickError = null;
  } catch (error) {
    lastTickAt = new Date().toISOString();
    lastTickError = String(error);
    app.log.error(error);
  } finally {
    tickInFlight = false;
  }
}

app.get("/health", async () => ({
  service: "scenario-agent",
  status: "ok",
  agent_id: agentId,
  label,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/scenario-paths", async () => {
  const result = await pool.query<ScenarioPathProposalRow>(
    `
      SELECT *
      FROM scenario_path_proposals
      ORDER BY created_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapScenarioRow),
  };
});

app.post("/v1/internal/scenario-agent/run-once", async () => {
  await tick();
  return { status: "ok", last_tick_at: lastTickAt, last_tick_error: lastTickError };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
