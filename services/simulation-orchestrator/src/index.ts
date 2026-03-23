import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import { buildDedupeKey, type SimulationRunStatus, type WorldSignal } from "@automakit/world-sim";

type WorldSignalRow = {
  id: string;
  dedupe_key: string;
  created_at: unknown;
};

type SimulationRunRow = {
  id: string;
  run_type: string;
  trigger_signal_ids: unknown;
  trigger_dedupe_key: string;
  status: SimulationRunStatus;
  started_at: unknown;
  completed_at: unknown;
  failure_reason: string | null;
  last_updated_at: unknown;
};

const port = Number(process.env.SIMULATION_ORCHESTRATOR_PORT ?? 4013);
const intervalMs = Number(process.env.SIMULATION_ORCHESTRATOR_INTERVAL_MS ?? 1000);
const signalWindow = Number(process.env.SIMULATION_ORCHESTRATOR_SIGNAL_WINDOW ?? 8);
const worldModelRequiredCount = Number(process.env.SIMULATION_WORLD_MODEL_REQUIRED ?? 2);
const scenarioRequiredCount = Number(process.env.SIMULATION_SCENARIO_REQUIRED ?? 2);
const synthesisRequiredCount = Number(process.env.SIMULATION_SYNTHESIS_REQUIRED ?? 1);

const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function mapRunRow(row: SimulationRunRow) {
  return {
    id: row.id,
    run_type: row.run_type,
    trigger_signal_ids: parseJsonField<string[]>(row.trigger_signal_ids),
    trigger_dedupe_key: row.trigger_dedupe_key,
    status: row.status,
    started_at: toIsoTimestamp(row.started_at),
    completed_at: row.completed_at ? toIsoTimestamp(row.completed_at) : null,
    failure_reason: row.failure_reason,
    last_updated_at: toIsoTimestamp(row.last_updated_at),
  };
}

async function fetchLatestSignals(limit: number) {
  const result = await pool.query<WorldSignalRow>(
    `
      SELECT id, dedupe_key, created_at
      FROM world_signals
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.reverse();
}

async function ensureCurrentRun() {
  const signals = await fetchLatestSignals(signalWindow);
  if (signals.length === 0) {
    return null;
  }

  const triggerSignalIds = signals.map((signal) => signal.id);
  const triggerDedupeKey = buildDedupeKey({
    trigger_signal_ids: triggerSignalIds,
    signal_dedupe_keys: signals.map((signal) => signal.dedupe_key),
  });

  const existing = await pool.query<Pick<SimulationRunRow, "id">>(
    `
      SELECT id
      FROM simulation_runs
      WHERE trigger_dedupe_key = $1
      LIMIT 1
    `,
    [triggerDedupeKey],
  );

  if (existing.rowCount) {
    return existing.rows[0].id;
  }

  const now = new Date().toISOString();
  const runId = randomUUID();
  await pool.query(
    `
      INSERT INTO simulation_runs (
        id,
        run_type,
        trigger_signal_ids,
        trigger_dedupe_key,
        status,
        started_at,
        last_updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz, $7::timestamptz)
      ON CONFLICT (trigger_dedupe_key) DO NOTHING
    `,
    [runId, "belief_refresh", JSON.stringify(triggerSignalIds), triggerDedupeKey, "world_model_pending", now, now],
  );

  return runId;
}

async function countDistinct(query: string, params: unknown[]) {
  const result = await pool.query<{ count: string }>(query, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function transitionRuns() {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT *
      FROM simulation_runs
      WHERE status IN ('world_model_pending', 'scenario_pending', 'synthesis_pending', 'ready_for_proposal')
      ORDER BY started_at ASC, id ASC
    `,
  );

  for (const row of result.rows) {
    const run = mapRunRow(row);

    if (run.status === "world_model_pending") {
      const worldStateCount = await countDistinct(
        `
          SELECT COUNT(DISTINCT agent_id)::text AS count
          FROM world_state_proposals
          WHERE run_id = $1
        `,
        [run.id],
      );
      const directHypothesisCount = await countDistinct(
        `
          SELECT COUNT(*)::text AS count
          FROM belief_hypothesis_proposals
          WHERE run_id = $1
        `,
        [run.id],
      );

      if (worldStateCount >= worldModelRequiredCount && directHypothesisCount > 0) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET status = 'scenario_pending', last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
      continue;
    }

    if (run.status === "scenario_pending") {
      const scenarioCount = await countDistinct(
        `
          SELECT COUNT(DISTINCT agent_id)::text AS count
          FROM scenario_path_proposals
          WHERE run_id = $1
        `,
        [run.id],
      );
      if (scenarioCount >= scenarioRequiredCount) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET status = 'synthesis_pending', last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
      continue;
    }

    if (run.status === "synthesis_pending") {
      const synthesisCount = await countDistinct(
        `
          SELECT COUNT(DISTINCT agent_id)::text AS count
          FROM synthesized_beliefs
          WHERE run_id = $1
        `,
        [run.id],
      );
      if (synthesisCount >= synthesisRequiredCount) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET status = 'ready_for_proposal', last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
      continue;
    }

    if (run.status === "ready_for_proposal") {
      const pendingBeliefs = await countDistinct(
        `
          SELECT COUNT(*)::text AS count
          FROM synthesized_beliefs
          WHERE run_id = $1
            AND status = 'new'
        `,
        [run.id],
      );
      const totalBeliefs = await countDistinct(
        `
          SELECT COUNT(*)::text AS count
          FROM synthesized_beliefs
          WHERE run_id = $1
        `,
        [run.id],
      );

      if (totalBeliefs > 0 && pendingBeliefs === 0) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET
              status = 'completed',
              completed_at = NOW(),
              last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
    }
  }
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    await ensureCurrentRun();
    await transitionRuns();
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
  service: "simulation-orchestrator",
  status: "ok",
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/simulation-runs", async () => {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT *
      FROM simulation_runs
      ORDER BY started_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapRunRow),
  };
});

app.post("/v1/internal/simulation-orchestrator/run-once", async () => {
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
