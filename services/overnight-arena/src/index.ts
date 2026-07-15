import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";

type JsonObject = Record<string, unknown>;

type OvernightCaseBundleRow = {
  id: string;
  case_date: unknown;
  case_key: string;
  status: string;
  close_captured_at: unknown;
  artifact_root: string;
  manifest_path: string;
  manifest_hash: string;
  source_snapshot_refs: unknown;
  market_universe_ref: string;
  belief_prior_ref: string;
  scenario_ensemble_ref: string | null;
  metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type OvernightSandboxRunRow = {
  id: string;
  case_bundle_id: string;
  run_key: string;
  status: string;
  execution_mode: string;
  sandbox_manifest: unknown;
  started_at: unknown | null;
  completed_at: unknown | null;
  failure_reason: string | null;
  created_at: unknown;
  updated_at: unknown;
};

type StatusCountRow = {
  status: string;
  count: string;
};

const port = Number(process.env.OVERNIGHT_ARENA_PORT ?? 4017);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

const requiredCaseFields = [
  "case_date",
  "case_key",
  "close_captured_at",
  "artifact_root",
  "manifest_path",
  "manifest_hash",
] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNullableString(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }
  return asString(value);
}

function ensureObjectPayload(value: unknown) {
  return isJsonObject(value) ? value : null;
}

function toDateOnly(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function isValidCaseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function isValidTimestamp(value: string) {
  return Number.isFinite(Date.parse(value));
}

function parseLimit(value: unknown, defaultValue: number, maxValue: number) {
  const numericValue = Number(value ?? defaultValue);
  if (!Number.isFinite(numericValue)) {
    return defaultValue;
  }
  return Math.max(1, Math.min(maxValue, Math.trunc(numericValue)));
}

function sendInvalidBody(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error });
}

function sendMissingField(reply: FastifyReply, error: string, field: string) {
  return reply.code(400).send({ error, field });
}

function sendInvalidField(reply: FastifyReply, error: string, field: string) {
  return reply.code(400).send({ error, field });
}

function mapStatusCounts(rows: StatusCountRow[]) {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function mapCaseBundleRow(row: OvernightCaseBundleRow) {
  return {
    id: row.id,
    case_date: toDateOnly(row.case_date),
    case_key: row.case_key,
    status: row.status,
    close_captured_at: toIsoTimestamp(row.close_captured_at),
    artifact_root: row.artifact_root,
    manifest_path: row.manifest_path,
    manifest_hash: row.manifest_hash,
    source_snapshot_refs: parseJsonField<unknown[]>(row.source_snapshot_refs),
    market_universe_ref: row.market_universe_ref,
    belief_prior_ref: row.belief_prior_ref,
    scenario_ensemble_ref: row.scenario_ensemble_ref,
    metadata: parseJsonField<JsonObject>(row.metadata),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function mapSandboxRunRow(row: OvernightSandboxRunRow) {
  return {
    id: row.id,
    case_bundle_id: row.case_bundle_id,
    run_key: row.run_key,
    status: row.status,
    execution_mode: row.execution_mode,
    sandbox_manifest: parseJsonField<JsonObject>(row.sandbox_manifest),
    started_at: row.started_at ? toIsoTimestamp(row.started_at) : null,
    completed_at: row.completed_at ? toIsoTimestamp(row.completed_at) : null,
    failure_reason: row.failure_reason,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function readOptionalTimestamp(
  body: JsonObject,
  field: "started_at" | "completed_at",
): { ok: true; value: string | null } | { ok: false; field: string } {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: null };
  }

  const value = asString(rawValue);
  if (!value || !isValidTimestamp(value)) {
    return { ok: false, field };
  }

  return { ok: true, value };
}

app.get("/health", async () => {
  const [caseCounts, runCounts] = await Promise.all([
    pool.query<StatusCountRow>(
      `
        SELECT status, COUNT(*)::text AS count
        FROM overnight_case_bundles
        GROUP BY status
        ORDER BY status
      `,
    ),
    pool.query<StatusCountRow>(
      `
        SELECT status, COUNT(*)::text AS count
        FROM overnight_sandbox_runs
        GROUP BY status
        ORDER BY status
      `,
    ),
  ]);

  const caseStatusCounts = mapStatusCounts(caseCounts.rows);
  const runStatusCounts = mapStatusCounts(runCounts.rows);

  return {
    service: "overnight-arena",
    status: "ok",
    case_bundle_count: Object.values(caseStatusCounts).reduce((total, count) => total + count, 0),
    case_bundle_status_counts: caseStatusCounts,
    sandbox_run_count: Object.values(runStatusCounts).reduce((total, count) => total + count, 0),
    sandbox_run_status_counts: runStatusCounts,
  };
});

app.get("/v1/internal/overnight/cases", async (request, reply) => {
  const query = request.query as { limit?: string; status?: string; case_date?: string };
  const limit = parseLimit(query.limit, 50, 200);
  const status = asString(query.status);
  const caseDate = asString(query.case_date);

  if (caseDate && !isValidCaseDate(caseDate)) {
    return sendInvalidField(reply, "overnight_case_invalid_field", "case_date");
  }

  const result = await pool.query<OvernightCaseBundleRow>(
    `
      SELECT *
      FROM overnight_case_bundles
      WHERE ($2::text IS NULL OR status = $2)
        AND ($3::date IS NULL OR case_date = $3::date)
      ORDER BY case_date DESC, created_at DESC, id DESC
      LIMIT $1
    `,
    [limit, status, caseDate],
  );

  return {
    items: result.rows.map(mapCaseBundleRow),
  };
});

app.get("/v1/internal/overnight/cases/:caseBundleId", async (request, reply) => {
  const caseBundleId = (request.params as { caseBundleId: string }).caseBundleId;
  const result = await pool.query<OvernightCaseBundleRow>(
    `
      SELECT *
      FROM overnight_case_bundles
      WHERE id = $1
      LIMIT 1
    `,
    [caseBundleId],
  );

  if ((result.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_case_not_found" });
  }

  return {
    item: mapCaseBundleRow(result.rows[0]),
  };
});

app.post("/v1/internal/overnight/cases", async (request, reply) => {
  const body = ensureObjectPayload(request.body);
  if (!body) {
    return sendInvalidBody(reply, "overnight_case_invalid_body");
  }

  for (const field of requiredCaseFields) {
    if (!asString(body[field])) {
      return sendMissingField(reply, "overnight_case_missing_required_field", field);
    }
  }

  const caseDate = asString(body.case_date)!;
  const closeCapturedAt = asString(body.close_captured_at)!;
  if (!isValidCaseDate(caseDate)) {
    return sendInvalidField(reply, "overnight_case_invalid_field", "case_date");
  }
  if (!isValidTimestamp(closeCapturedAt)) {
    return sendInvalidField(reply, "overnight_case_invalid_field", "close_captured_at");
  }

  const sourceSnapshotRefs = body.source_snapshot_refs ?? [];
  if (!Array.isArray(sourceSnapshotRefs)) {
    return sendInvalidField(reply, "overnight_case_invalid_field", "source_snapshot_refs");
  }

  const metadata = body.metadata ?? {};
  if (!isJsonObject(metadata)) {
    return sendInvalidField(reply, "overnight_case_invalid_field", "metadata");
  }

  const caseKey = asString(body.case_key)!;
  const dateConflict = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM overnight_case_bundles
      WHERE case_date = $1::date
        AND case_key <> $2
      LIMIT 1
    `,
    [caseDate, caseKey],
  );

  if ((dateConflict.rowCount ?? 0) > 0) {
    return reply.code(409).send({ error: "overnight_case_date_conflict", field: "case_date" });
  }

  const result = await pool.query<OvernightCaseBundleRow>(
    `
      INSERT INTO overnight_case_bundles (
        id,
        case_date,
        case_key,
        status,
        close_captured_at,
        artifact_root,
        manifest_path,
        manifest_hash,
        source_snapshot_refs,
        market_universe_ref,
        belief_prior_ref,
        scenario_ensemble_ref,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2::date,
        $3,
        $4,
        $5::timestamptz,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10,
        $11,
        $12,
        $13::jsonb,
        NOW(),
        NOW()
      )
      ON CONFLICT (case_key) DO UPDATE SET
        case_date = EXCLUDED.case_date,
        status = EXCLUDED.status,
        close_captured_at = EXCLUDED.close_captured_at,
        artifact_root = EXCLUDED.artifact_root,
        manifest_path = EXCLUDED.manifest_path,
        manifest_hash = EXCLUDED.manifest_hash,
        source_snapshot_refs = EXCLUDED.source_snapshot_refs,
        market_universe_ref = EXCLUDED.market_universe_ref,
        belief_prior_ref = EXCLUDED.belief_prior_ref,
        scenario_ensemble_ref = EXCLUDED.scenario_ensemble_ref,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `,
    [
      asString(body.id) ?? randomUUID(),
      caseDate,
      caseKey,
      asString(body.status) ?? "created",
      closeCapturedAt,
      asString(body.artifact_root)!,
      asString(body.manifest_path)!,
      asString(body.manifest_hash)!,
      JSON.stringify(sourceSnapshotRefs),
      asString(body.market_universe_ref) ?? "",
      asString(body.belief_prior_ref) ?? "",
      asNullableString(body.scenario_ensemble_ref),
      JSON.stringify(metadata),
    ],
  );

  return reply.code(201).send({
    item: mapCaseBundleRow(result.rows[0]),
  });
});

app.get("/v1/internal/overnight/runs", async (request) => {
  const query = request.query as { limit?: string; case_bundle_id?: string; status?: string };
  const limit = parseLimit(query.limit, 50, 200);
  const caseBundleId = asString(query.case_bundle_id);
  const status = asString(query.status);

  const result = await pool.query<OvernightSandboxRunRow>(
    `
      SELECT *
      FROM overnight_sandbox_runs
      WHERE ($2::text IS NULL OR case_bundle_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit, caseBundleId, status],
  );

  return {
    items: result.rows.map(mapSandboxRunRow),
  };
});

app.post("/v1/internal/overnight/runs", async (request, reply) => {
  const body = ensureObjectPayload(request.body);
  if (!body) {
    return sendInvalidBody(reply, "overnight_run_invalid_body");
  }

  const caseBundleId = asString(body.case_bundle_id);
  if (!caseBundleId) {
    return sendMissingField(reply, "overnight_run_missing_required_field", "case_bundle_id");
  }

  const runKey = asString(body.run_key);
  if (!runKey) {
    return sendMissingField(reply, "overnight_run_missing_required_field", "run_key");
  }

  const sandboxManifest = body.sandbox_manifest ?? {};
  if (!isJsonObject(sandboxManifest)) {
    return sendInvalidField(reply, "overnight_run_invalid_field", "sandbox_manifest");
  }

  const startedAt = readOptionalTimestamp(body, "started_at");
  if (!startedAt.ok) {
    return sendInvalidField(reply, "overnight_run_invalid_field", startedAt.field);
  }

  const completedAt = readOptionalTimestamp(body, "completed_at");
  if (!completedAt.ok) {
    return sendInvalidField(reply, "overnight_run_invalid_field", completedAt.field);
  }

  const caseBundle = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM overnight_case_bundles
      WHERE id = $1
      LIMIT 1
    `,
    [caseBundleId],
  );

  if ((caseBundle.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_case_not_found", field: "case_bundle_id" });
  }

  const runConflict = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM overnight_sandbox_runs
      WHERE run_key = $1
      LIMIT 1
    `,
    [runKey],
  );

  if ((runConflict.rowCount ?? 0) > 0) {
    return reply.code(409).send({ error: "overnight_run_key_conflict", field: "run_key" });
  }

  const result = await pool.query<OvernightSandboxRunRow>(
    `
      INSERT INTO overnight_sandbox_runs (
        id,
        case_bundle_id,
        run_key,
        status,
        execution_mode,
        sandbox_manifest,
        started_at,
        completed_at,
        failure_reason,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        $7::timestamptz,
        $8::timestamptz,
        $9,
        NOW(),
        NOW()
      )
      RETURNING *
    `,
    [
      asString(body.id) ?? randomUUID(),
      caseBundleId,
      runKey,
      asString(body.status) ?? "created",
      asString(body.execution_mode) ?? "projection",
      JSON.stringify(sandboxManifest),
      startedAt.value,
      completedAt.value,
      asNullableString(body.failure_reason),
    ],
  );

  return reply.code(201).send({
    item: mapSandboxRunRow(result.rows[0]),
  });
});

app.get("/v1/internal/overnight/runs/:runId", async (request, reply) => {
  const runId = (request.params as { runId: string }).runId;
  const result = await pool.query<OvernightSandboxRunRow>(
    `
      SELECT *
      FROM overnight_sandbox_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId],
  );

  if ((result.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_run_not_found" });
  }

  return {
    item: mapSandboxRunRow(result.rows[0]),
  };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
