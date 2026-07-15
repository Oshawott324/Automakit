import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

type OvernightScenarioRow = {
  id: string;
  case_bundle_id: string;
  scenario_key: string;
  scenario_agent_id: string | null;
  scenario_ref: string;
  scenario_hash: string;
  probability: number;
  manifest: unknown;
  created_at: unknown;
};

type OvernightAgentRunRow = {
  id: string;
  sandbox_run_id: string;
  participant_agent_id: string;
  participant_version: string;
  status: string;
  starting_cash: number;
  sandbox_portfolio_ref: string | null;
  action_trace_ref: string | null;
  scorecard_id: string | null;
  started_at: unknown | null;
  completed_at: unknown | null;
  failure_reason: string | null;
  created_at: unknown;
  updated_at: unknown;
};

type OvernightScorecardRow = {
  id: string;
  sandbox_run_id: string;
  agent_run_id: string | null;
  case_bundle_id: string;
  score_total: number | null;
  score_dimensions: unknown;
  hard_failures: unknown;
  soft_failures: unknown;
  verifier_version: string;
  input_manifest_hash: string;
  scenario_hashes: unknown;
  market_impact_label: string;
  live_claim: boolean;
  created_at: unknown;
};

type OvernightSettlementRow = {
  id: string;
  case_bundle_id: string;
  settlement_key: string;
  actual_data_ref: string;
  actual_data_hash: string;
  settlement_manifest: unknown;
  settled_at: unknown;
  created_at: unknown;
};

type SandboxRunCaseRow = {
  id: string;
  case_bundle_id: string;
  manifest_hash: string;
};

type StatusCountRow = {
  status: string;
  count: string;
};

type ExternalMarketRefSourceRow = {
  id: string;
  belief_source_id: string;
  source_key: string | null;
  source_adapter: string | null;
  source_url: string | null;
  source_trust_tier: string | null;
  source_market_id: string;
  source_market_slug: string | null;
  market_url: string;
  title: string;
  question: string | null;
  description: string | null;
  category: string | null;
  status: string;
  close_time: unknown;
  end_time: unknown;
  raw_payload: unknown;
  provenance: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type BeliefPriorSnapshotSourceRow = {
  id: string;
  snapshot_key: string;
  belief_source_id: string;
  source_key: string | null;
  source_adapter: string | null;
  source_url: string | null;
  source_trust_tier: string | null;
  external_market_ref_id: string;
  source_market_id: string;
  outcome_id: string;
  outcome_name: string;
  probability: number;
  liquidity: number | null;
  volume: number | null;
  best_bid: number | null;
  best_ask: number | null;
  last_trade_price: number | null;
  market_status: string;
  outcomes: unknown;
  tokens: unknown;
  prices: unknown;
  raw_payload: unknown;
  provenance: unknown;
  fetched_at: unknown;
  effective_at: unknown;
  created_at: unknown;
  ref_source_market_slug: string | null;
  ref_market_url: string;
  ref_title: string;
  ref_question: string | null;
  ref_category: string | null;
  ref_status: string;
  ref_close_time: unknown;
  ref_end_time: unknown;
};

type ArtifactRef = {
  path: string;
  sha256: string;
};

type SourceSnapshotRef = ArtifactRef & {
  kind: "external_market_refs" | "belief_prior_snapshots";
};

type MarketUniverseItem = {
  external_market_ref_id: string;
  source_market_id: string;
  source_market_slug: string | null;
  source_key: string | null;
  source_adapter: string | null;
  market_url: string;
  title: string;
  question: string | null;
  category: string | null;
  status: string;
  close_time: string | null;
  end_time: string | null;
  latest_prior_fetched_at: string | null;
};

const port = Number(process.env.OVERNIGHT_ARENA_PORT ?? 4017);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

const caseBundleSchemaVersion = "overnight_case_bundle.v1";
const defaultCaseArtifactRoot = ".automakit/overnight-cases";
const defaultSourceLimit = 500;
const defaultBeliefPriorLimit = 1000;
const maxSourceLimit = 5000;
const maxBeliefPriorLimit = 10000;

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

function readBuildLimit(
  body: JsonObject,
  field: "source_limit" | "belief_prior_limit",
  defaultValue: number,
  maxValue: number,
): { ok: true; value: number } | { ok: false; expected: string } {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: defaultValue };
  }

  const numericValue =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string" && rawValue.trim().length > 0
        ? Number(rawValue)
        : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue < 1 || numericValue > maxValue) {
    return { ok: false, expected: `integer between 1 and ${maxValue}` };
  }

  return { ok: true, value: numericValue };
}

type FieldReadResult<T> = { ok: true; value: T } | { ok: false; field: string };

function readRequiredFiniteNumber(body: JsonObject, field: string): FieldReadResult<number> {
  const rawValue = body[field];
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return { ok: false, field };
  }

  return { ok: true, value: rawValue };
}

function readOptionalFiniteNumber(body: JsonObject, field: string): FieldReadResult<number | null> {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: null };
  }

  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return { ok: false, field };
  }

  return { ok: true, value: rawValue };
}

function readOptionalStringField(body: JsonObject, field: string): FieldReadResult<string | null> {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: null };
  }

  const value = asString(rawValue);
  if (!value) {
    return { ok: false, field };
  }

  return { ok: true, value };
}

function readDefaultedStringField(body: JsonObject, field: string, defaultValue: string): FieldReadResult<string> {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: defaultValue };
  }

  const value = asString(rawValue);
  if (!value) {
    return { ok: false, field };
  }

  return { ok: true, value };
}

function readDefaultedJsonObjectField(
  body: JsonObject,
  field: string,
  defaultValue: JsonObject,
): FieldReadResult<JsonObject> {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: defaultValue };
  }

  if (!isJsonObject(rawValue)) {
    return { ok: false, field };
  }

  return { ok: true, value: rawValue };
}

function readDefaultedArrayField(body: JsonObject, field: string): FieldReadResult<unknown[]> {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(rawValue)) {
    return { ok: false, field };
  }

  return { ok: true, value: rawValue };
}

function readDefaultedBooleanField(
  body: JsonObject,
  field: string,
  defaultValue: boolean,
): FieldReadResult<boolean> {
  const rawValue = body[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: defaultValue };
  }

  if (typeof rawValue !== "boolean") {
    return { ok: false, field };
  }

  return { ok: true, value: rawValue };
}

function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item === undefined ? null : item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const entries = Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`);
    return `{${entries.join(",")}}`;
  }

  return "null";
}

function stableJson(value: unknown) {
  return `${stableStringify(value)}\n`;
}

function sha256Ref(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function relativeArtifactPath(artifactRoot: string, filePath: string) {
  const relativePath = path.relative(artifactRoot, filePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }
  return filePath;
}

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

async function writeJsonArtifact(artifactRoot: string, filePath: string, value: unknown): Promise<ArtifactRef> {
  const json = stableJson(value);
  await writeFile(filePath, json, { encoding: "utf8" });
  return {
    path: relativeArtifactPath(artifactRoot, filePath),
    sha256: sha256Ref(json),
  };
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

function mapScenarioRow(row: OvernightScenarioRow) {
  return {
    id: row.id,
    case_bundle_id: row.case_bundle_id,
    scenario_key: row.scenario_key,
    scenario_agent_id: row.scenario_agent_id,
    scenario_ref: row.scenario_ref,
    scenario_hash: row.scenario_hash,
    probability: Number(row.probability),
    manifest: parseJsonField<JsonObject>(row.manifest),
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapAgentRunRow(row: OvernightAgentRunRow) {
  return {
    id: row.id,
    sandbox_run_id: row.sandbox_run_id,
    participant_agent_id: row.participant_agent_id,
    participant_version: row.participant_version,
    status: row.status,
    starting_cash: Number(row.starting_cash),
    sandbox_portfolio_ref: row.sandbox_portfolio_ref,
    action_trace_ref: row.action_trace_ref,
    scorecard_id: row.scorecard_id,
    started_at: row.started_at ? toIsoTimestamp(row.started_at) : null,
    completed_at: row.completed_at ? toIsoTimestamp(row.completed_at) : null,
    failure_reason: row.failure_reason,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function mapScorecardRow(row: OvernightScorecardRow) {
  return {
    id: row.id,
    sandbox_run_id: row.sandbox_run_id,
    agent_run_id: row.agent_run_id,
    case_bundle_id: row.case_bundle_id,
    score_total: row.score_total === null ? null : Number(row.score_total),
    score_dimensions: parseJsonField<JsonObject>(row.score_dimensions),
    hard_failures: parseJsonField<unknown[]>(row.hard_failures),
    soft_failures: parseJsonField<unknown[]>(row.soft_failures),
    verifier_version: row.verifier_version,
    input_manifest_hash: row.input_manifest_hash,
    scenario_hashes: parseJsonField<unknown[]>(row.scenario_hashes),
    market_impact_label: row.market_impact_label,
    live_claim: row.live_claim,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapSettlementRow(row: OvernightSettlementRow) {
  return {
    id: row.id,
    case_bundle_id: row.case_bundle_id,
    settlement_key: row.settlement_key,
    actual_data_ref: row.actual_data_ref,
    actual_data_hash: row.actual_data_hash,
    settlement_manifest: parseJsonField<JsonObject>(row.settlement_manifest),
    settled_at: toIsoTimestamp(row.settled_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapExternalMarketRefSourceRow(row: ExternalMarketRefSourceRow) {
  return {
    id: row.id,
    belief_source: {
      id: row.belief_source_id,
      key: row.source_key,
      adapter: row.source_adapter,
      source_url: row.source_url,
      trust_tier: row.source_trust_tier,
    },
    source_market_id: row.source_market_id,
    source_market_slug: row.source_market_slug,
    market_url: row.market_url,
    title: row.title,
    question: row.question,
    description: row.description,
    category: row.category,
    status: row.status,
    close_time: row.close_time ? toIsoTimestamp(row.close_time) : null,
    end_time: row.end_time ? toIsoTimestamp(row.end_time) : null,
    raw_payload: parseJsonField<JsonObject>(row.raw_payload),
    provenance: parseJsonField<JsonObject>(row.provenance),
    first_seen_at: toIsoTimestamp(row.first_seen_at),
    last_seen_at: toIsoTimestamp(row.last_seen_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function mapBeliefPriorSnapshotSourceRow(row: BeliefPriorSnapshotSourceRow) {
  return {
    id: row.id,
    snapshot_key: row.snapshot_key,
    belief_source: {
      id: row.belief_source_id,
      key: row.source_key,
      adapter: row.source_adapter,
      source_url: row.source_url,
      trust_tier: row.source_trust_tier,
    },
    external_market_ref: {
      id: row.external_market_ref_id,
      source_market_id: row.source_market_id,
      source_market_slug: row.ref_source_market_slug,
      market_url: row.ref_market_url,
      title: row.ref_title,
      question: row.ref_question,
      category: row.ref_category,
      status: row.ref_status,
      close_time: row.ref_close_time ? toIsoTimestamp(row.ref_close_time) : null,
      end_time: row.ref_end_time ? toIsoTimestamp(row.ref_end_time) : null,
    },
    source_market_id: row.source_market_id,
    outcome_id: row.outcome_id,
    outcome_name: row.outcome_name,
    probability: Number(row.probability),
    liquidity: row.liquidity === null ? null : Number(row.liquidity),
    volume: row.volume === null ? null : Number(row.volume),
    best_bid: row.best_bid === null ? null : Number(row.best_bid),
    best_ask: row.best_ask === null ? null : Number(row.best_ask),
    last_trade_price: row.last_trade_price === null ? null : Number(row.last_trade_price),
    market_status: row.market_status,
    outcomes: parseJsonField<unknown[]>(row.outcomes),
    tokens: parseJsonField<unknown[]>(row.tokens),
    prices: parseJsonField<unknown[]>(row.prices),
    raw_payload: parseJsonField<JsonObject>(row.raw_payload),
    provenance: parseJsonField<JsonObject>(row.provenance),
    fetched_at: toIsoTimestamp(row.fetched_at),
    effective_at: row.effective_at ? toIsoTimestamp(row.effective_at) : null,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function buildMarketUniverse(
  externalMarketRefs: ReturnType<typeof mapExternalMarketRefSourceRow>[],
  beliefPriorSnapshots: ReturnType<typeof mapBeliefPriorSnapshotSourceRow>[],
) {
  const markets = new Map<string, MarketUniverseItem>();

  for (const ref of externalMarketRefs) {
    markets.set(ref.id, {
      external_market_ref_id: ref.id,
      source_market_id: ref.source_market_id,
      source_market_slug: ref.source_market_slug,
      source_key: ref.belief_source.key,
      source_adapter: ref.belief_source.adapter,
      market_url: ref.market_url,
      title: ref.title,
      question: ref.question,
      category: ref.category,
      status: ref.status,
      close_time: ref.close_time,
      end_time: ref.end_time,
      latest_prior_fetched_at: null,
    });
  }

  for (const snapshot of beliefPriorSnapshots) {
    const current = markets.get(snapshot.external_market_ref.id);
    if (!current) {
      markets.set(snapshot.external_market_ref.id, {
        external_market_ref_id: snapshot.external_market_ref.id,
        source_market_id: snapshot.external_market_ref.source_market_id,
        source_market_slug: snapshot.external_market_ref.source_market_slug,
        source_key: snapshot.belief_source.key,
        source_adapter: snapshot.belief_source.adapter,
        market_url: snapshot.external_market_ref.market_url,
        title: snapshot.external_market_ref.title,
        question: snapshot.external_market_ref.question,
        category: snapshot.external_market_ref.category,
        status: snapshot.external_market_ref.status,
        close_time: snapshot.external_market_ref.close_time,
        end_time: snapshot.external_market_ref.end_time,
        latest_prior_fetched_at: snapshot.fetched_at,
      });
      continue;
    }

    if (!current.latest_prior_fetched_at || snapshot.fetched_at > current.latest_prior_fetched_at) {
      current.latest_prior_fetched_at = snapshot.fetched_at;
    }
  }

  return Array.from(markets.values()).sort((left, right) =>
    compareText(
      [left.source_key ?? "", left.source_market_id, left.external_market_ref_id].join(":"),
      [right.source_key ?? "", right.source_market_id, right.external_market_ref_id].join(":"),
    ),
  );
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

app.get("/v1/internal/overnight/cases/:caseBundleId/scenarios", async (request, reply) => {
  const caseBundleId = (request.params as { caseBundleId: string }).caseBundleId;
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

  const result = await pool.query<OvernightScenarioRow>(
    `
      SELECT *
      FROM overnight_scenarios
      WHERE case_bundle_id = $1
      ORDER BY created_at DESC, scenario_key ASC, id DESC
    `,
    [caseBundleId],
  );

  return {
    items: result.rows.map(mapScenarioRow),
  };
});

app.post("/v1/internal/overnight/cases/:caseBundleId/scenarios", async (request, reply) => {
  const caseBundleId = (request.params as { caseBundleId: string }).caseBundleId;
  const body = ensureObjectPayload(request.body);
  if (!body) {
    return sendInvalidBody(reply, "overnight_scenario_invalid_body");
  }

  const scenarioKey = asString(body.scenario_key);
  if (!scenarioKey) {
    return sendMissingField(reply, "overnight_scenario_missing_required_field", "scenario_key");
  }

  const scenarioRef = asString(body.scenario_ref);
  if (!scenarioRef) {
    return sendMissingField(reply, "overnight_scenario_missing_required_field", "scenario_ref");
  }

  const scenarioHash = asString(body.scenario_hash);
  if (!scenarioHash) {
    return sendMissingField(reply, "overnight_scenario_missing_required_field", "scenario_hash");
  }

  if (body.probability === undefined || body.probability === null) {
    return sendMissingField(reply, "overnight_scenario_missing_required_field", "probability");
  }

  const probability = readRequiredFiniteNumber(body, "probability");
  if (!probability.ok || probability.value < 0 || probability.value > 1) {
    return reply.code(400).send({
      error: "overnight_scenario_invalid_field",
      field: "probability",
      expected: "finite number between 0 and 1",
    });
  }

  const scenarioAgentId = readOptionalStringField(body, "scenario_agent_id");
  if (!scenarioAgentId.ok) {
    return sendInvalidField(reply, "overnight_scenario_invalid_field", scenarioAgentId.field);
  }

  const manifest = readDefaultedJsonObjectField(body, "manifest", {});
  if (!manifest.ok) {
    return sendInvalidField(reply, "overnight_scenario_invalid_field", manifest.field);
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

  if (scenarioAgentId.value) {
    const agent = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM agents
        WHERE id = $1
        LIMIT 1
      `,
      [scenarioAgentId.value],
    );

    if ((agent.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "overnight_agent_not_found", field: "scenario_agent_id" });
    }
  }

  const result = await pool.query<OvernightScenarioRow>(
    `
      INSERT INTO overnight_scenarios (
        id,
        case_bundle_id,
        scenario_key,
        scenario_agent_id,
        scenario_ref,
        scenario_hash,
        probability,
        manifest,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        NOW()
      )
      ON CONFLICT (case_bundle_id, scenario_key) DO UPDATE SET
        scenario_agent_id = EXCLUDED.scenario_agent_id,
        scenario_ref = EXCLUDED.scenario_ref,
        scenario_hash = EXCLUDED.scenario_hash,
        probability = EXCLUDED.probability,
        manifest = EXCLUDED.manifest
      RETURNING *
    `,
    [
      asString(body.id) ?? randomUUID(),
      caseBundleId,
      scenarioKey,
      scenarioAgentId.value,
      scenarioRef,
      scenarioHash,
      probability.value,
      JSON.stringify(manifest.value),
    ],
  );

  return reply.code(201).send({
    item: mapScenarioRow(result.rows[0]),
  });
});

app.get("/v1/internal/overnight/cases/:caseBundleId/settlements", async (request, reply) => {
  const caseBundleId = (request.params as { caseBundleId: string }).caseBundleId;
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

  const result = await pool.query<OvernightSettlementRow>(
    `
      SELECT *
      FROM overnight_settlements
      WHERE case_bundle_id = $1
      ORDER BY settled_at DESC, created_at DESC, id DESC
    `,
    [caseBundleId],
  );

  return {
    items: result.rows.map(mapSettlementRow),
  };
});

app.post("/v1/internal/overnight/cases/:caseBundleId/settlements", async (request, reply) => {
  const caseBundleId = (request.params as { caseBundleId: string }).caseBundleId;
  const body = ensureObjectPayload(request.body);
  if (!body) {
    return sendInvalidBody(reply, "overnight_settlement_invalid_body");
  }

  const settlementKey = asString(body.settlement_key);
  if (!settlementKey) {
    return sendMissingField(reply, "overnight_settlement_missing_required_field", "settlement_key");
  }

  const actualDataRef = asString(body.actual_data_ref);
  if (!actualDataRef) {
    return sendMissingField(reply, "overnight_settlement_missing_required_field", "actual_data_ref");
  }

  const actualDataHash = asString(body.actual_data_hash);
  if (!actualDataHash) {
    return sendMissingField(reply, "overnight_settlement_missing_required_field", "actual_data_hash");
  }

  const settledAt = asString(body.settled_at);
  if (!settledAt) {
    return sendMissingField(reply, "overnight_settlement_missing_required_field", "settled_at");
  }
  if (!isValidTimestamp(settledAt)) {
    return sendInvalidField(reply, "overnight_settlement_invalid_field", "settled_at");
  }

  const settlementManifest = readDefaultedJsonObjectField(body, "settlement_manifest", {});
  if (!settlementManifest.ok) {
    return sendInvalidField(reply, "overnight_settlement_invalid_field", settlementManifest.field);
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

  const result = await pool.query<OvernightSettlementRow>(
    `
      INSERT INTO overnight_settlements (
        id,
        case_bundle_id,
        settlement_key,
        actual_data_ref,
        actual_data_hash,
        settlement_manifest,
        settled_at,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        $7::timestamptz,
        NOW()
      )
      ON CONFLICT (settlement_key) DO UPDATE SET
        case_bundle_id = EXCLUDED.case_bundle_id,
        actual_data_ref = EXCLUDED.actual_data_ref,
        actual_data_hash = EXCLUDED.actual_data_hash,
        settlement_manifest = EXCLUDED.settlement_manifest,
        settled_at = EXCLUDED.settled_at
      RETURNING *
    `,
    [
      asString(body.id) ?? randomUUID(),
      caseBundleId,
      settlementKey,
      actualDataRef,
      actualDataHash,
      JSON.stringify(settlementManifest.value),
      settledAt,
    ],
  );

  return reply.code(201).send({
    item: mapSettlementRow(result.rows[0]),
  });
});

app.post("/v1/internal/overnight/cases/build", async (request, reply) => {
  const body = ensureObjectPayload(request.body);
  if (!body) {
    return sendInvalidBody(reply, "overnight_case_build_invalid_body");
  }

  const caseDate = asString(body.case_date);
  if (!caseDate) {
    return sendMissingField(reply, "overnight_case_build_missing_required_field", "case_date");
  }
  if (!isValidCaseDate(caseDate)) {
    return sendInvalidField(reply, "overnight_case_build_invalid_field", "case_date");
  }

  const closeCapturedAt = asString(body.close_captured_at);
  if (!closeCapturedAt) {
    return sendMissingField(reply, "overnight_case_build_missing_required_field", "close_captured_at");
  }
  if (!isValidTimestamp(closeCapturedAt)) {
    return sendInvalidField(reply, "overnight_case_build_invalid_field", "close_captured_at");
  }

  const caseKey =
    body.case_key === undefined || body.case_key === null ? `overnight_sandbox:${caseDate}` : asString(body.case_key);
  if (!caseKey) {
    return sendInvalidField(reply, "overnight_case_build_invalid_field", "case_key");
  }

  const status = body.status === undefined || body.status === null ? "created" : asString(body.status);
  if (!status) {
    return sendInvalidField(reply, "overnight_case_build_invalid_field", "status");
  }

  const artifactRootInput =
    body.artifact_root === undefined || body.artifact_root === null
      ? process.env.OVERNIGHT_ARENA_ARTIFACT_ROOT ?? defaultCaseArtifactRoot
      : asString(body.artifact_root);
  if (!artifactRootInput) {
    return sendInvalidField(reply, "overnight_case_build_invalid_field", "artifact_root");
  }

  const sourceLimit = readBuildLimit(body, "source_limit", defaultSourceLimit, maxSourceLimit);
  if (!sourceLimit.ok) {
    return reply
      .code(400)
      .send({ error: "overnight_case_build_invalid_field", field: "source_limit", expected: sourceLimit.expected });
  }

  const beliefPriorLimit = readBuildLimit(
    body,
    "belief_prior_limit",
    defaultBeliefPriorLimit,
    maxBeliefPriorLimit,
  );
  if (!beliefPriorLimit.ok) {
    return reply.code(400).send({
      error: "overnight_case_build_invalid_field",
      field: "belief_prior_limit",
      expected: beliefPriorLimit.expected,
    });
  }

  const metadata = body.metadata ?? {};
  if (!isJsonObject(metadata)) {
    return sendInvalidField(reply, "overnight_case_build_invalid_field", "metadata");
  }

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

  const [externalMarketRefsResult, beliefPriorSnapshotsResult] = await Promise.all([
    pool.query<ExternalMarketRefSourceRow>(
      `
        SELECT
          refs.*,
          sources.key AS source_key,
          sources.adapter AS source_adapter,
          sources.source_url AS source_url,
          sources.trust_tier AS source_trust_tier
        FROM external_market_refs refs
        JOIN belief_sources sources ON sources.id = refs.belief_source_id
        WHERE refs.last_seen_at <= $2::timestamptz
        ORDER BY refs.last_seen_at DESC, refs.id DESC
        LIMIT $1
      `,
      [sourceLimit.value, closeCapturedAt],
    ),
    pool.query<BeliefPriorSnapshotSourceRow>(
      `
        SELECT
          snapshots.*,
          sources.key AS source_key,
          sources.adapter AS source_adapter,
          sources.source_url AS source_url,
          sources.trust_tier AS source_trust_tier,
          refs.source_market_slug AS ref_source_market_slug,
          refs.market_url AS ref_market_url,
          refs.title AS ref_title,
          refs.question AS ref_question,
          refs.category AS ref_category,
          refs.status AS ref_status,
          refs.close_time AS ref_close_time,
          refs.end_time AS ref_end_time
        FROM belief_prior_snapshots snapshots
        JOIN belief_sources sources ON sources.id = snapshots.belief_source_id
        JOIN external_market_refs refs ON refs.id = snapshots.external_market_ref_id
        WHERE snapshots.fetched_at <= $2::timestamptz
        ORDER BY snapshots.fetched_at DESC, snapshots.id DESC
        LIMIT $1
      `,
      [beliefPriorLimit.value, closeCapturedAt],
    ),
  ]);

  const externalMarketRefs = externalMarketRefsResult.rows.map(mapExternalMarketRefSourceRow);
  const beliefPriorSnapshots = beliefPriorSnapshotsResult.rows.map(mapBeliefPriorSnapshotSourceRow);

  if (externalMarketRefs.length === 0 && beliefPriorSnapshots.length === 0) {
    return reply.code(422).send({ error: "overnight_case_source_data_empty" });
  }

  const artifactRoot = path.resolve(process.cwd(), artifactRootInput);
  const caseArtifactDir = path.join(artifactRoot, caseDate);
  const sourceSnapshotsDir = path.join(caseArtifactDir, "source-snapshots");
  await mkdir(sourceSnapshotsDir, { recursive: true });

  const externalMarketRefsSnapshot = {
    schema_version: "overnight_source_snapshot.external_market_refs.v1",
    regime: "overnight_sandbox",
    case_date: caseDate,
    close_captured_at: closeCapturedAt,
    source_limit: sourceLimit.value,
    source_count: externalMarketRefs.length,
    rows: externalMarketRefs,
  };
  const beliefPriorSnapshotsSnapshot = {
    schema_version: "overnight_source_snapshot.belief_prior_snapshots.v1",
    regime: "overnight_sandbox",
    case_date: caseDate,
    close_captured_at: closeCapturedAt,
    belief_prior_limit: beliefPriorLimit.value,
    source_count: beliefPriorSnapshots.length,
    rows: beliefPriorSnapshots,
  };
  const marketUniverseMarkets = buildMarketUniverse(externalMarketRefs, beliefPriorSnapshots);
  const marketUniverse = {
    schema_version: "overnight_market_universe.v1",
    regime: "overnight_sandbox",
    case_date: caseDate,
    close_captured_at: closeCapturedAt,
    market_count: marketUniverseMarkets.length,
    markets: marketUniverseMarkets,
  };
  const beliefPriors = {
    schema_version: "overnight_belief_priors.v1",
    regime: "overnight_sandbox",
    case_date: caseDate,
    close_captured_at: closeCapturedAt,
    snapshot_count: beliefPriorSnapshots.length,
    snapshots: beliefPriorSnapshots,
  };

  const externalMarketRefsRef = await writeJsonArtifact(
    artifactRoot,
    path.join(sourceSnapshotsDir, "external-market-refs.json"),
    externalMarketRefsSnapshot,
  );
  const beliefPriorSnapshotsRef = await writeJsonArtifact(
    artifactRoot,
    path.join(sourceSnapshotsDir, "belief-prior-snapshots.json"),
    beliefPriorSnapshotsSnapshot,
  );
  const beliefPriorRef = await writeJsonArtifact(
    artifactRoot,
    path.join(caseArtifactDir, "belief-priors.json"),
    beliefPriors,
  );
  const marketUniverseRef = await writeJsonArtifact(
    artifactRoot,
    path.join(caseArtifactDir, "market-universe.json"),
    marketUniverse,
  );
  const sourceSnapshotRefs: SourceSnapshotRef[] = [
    { kind: "external_market_refs", ...externalMarketRefsRef },
    { kind: "belief_prior_snapshots", ...beliefPriorSnapshotsRef },
  ];

  const manifest = {
    schema_version: caseBundleSchemaVersion,
    regime: "overnight_sandbox",
    case_date: caseDate,
    case_key: caseKey,
    close_captured_at: closeCapturedAt,
    source_snapshot_refs: sourceSnapshotRefs,
    market_universe_ref: marketUniverseRef,
    belief_prior_ref: beliefPriorRef,
    scenario_ensemble_ref: null,
    source_counts: {
      external_market_refs: externalMarketRefs.length,
      belief_prior_snapshots: beliefPriorSnapshots.length,
      market_universe: marketUniverse.markets.length,
    },
    created_by: "overnight-arena",
    live_claim: false,
    market_impact_label: "simulated_after_close",
    notes: [
      "Scenario ensemble is not generated yet; this bundle freezes persisted source snapshots, market universe, and belief priors only.",
    ],
  };
  const manifestJson = stableJson(manifest);
  const manifestHash = sha256Ref(manifestJson);
  const manifestPath = path.join(caseArtifactDir, "manifest.json");
  await writeFile(manifestPath, manifestJson, { encoding: "utf8" });
  const manifestRefPath = relativeArtifactPath(artifactRoot, manifestPath);

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
      randomUUID(),
      caseDate,
      caseKey,
      status,
      closeCapturedAt,
      artifactRoot,
      manifestRefPath,
      manifestHash,
      JSON.stringify(sourceSnapshotRefs),
      marketUniverseRef.path,
      beliefPriorRef.path,
      null,
      JSON.stringify(metadata),
    ],
  );

  return reply.code(201).send({
    item: mapCaseBundleRow(result.rows[0]),
  });
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

app.get("/v1/internal/overnight/runs/:runId/agent-runs", async (request, reply) => {
  const runId = (request.params as { runId: string }).runId;
  const run = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM overnight_sandbox_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId],
  );

  if ((run.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_run_not_found", field: "run_id" });
  }

  const result = await pool.query<OvernightAgentRunRow>(
    `
      SELECT *
      FROM overnight_agent_runs
      WHERE sandbox_run_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [runId],
  );

  return {
    items: result.rows.map(mapAgentRunRow),
  };
});

app.post("/v1/internal/overnight/runs/:runId/agent-runs", async (request, reply) => {
  const runId = (request.params as { runId: string }).runId;
  const body = ensureObjectPayload(request.body);
  if (!body) {
    return sendInvalidBody(reply, "overnight_agent_run_invalid_body");
  }

  const participantAgentId = asString(body.participant_agent_id);
  if (!participantAgentId) {
    return sendMissingField(reply, "overnight_agent_run_missing_required_field", "participant_agent_id");
  }

  const participantVersion = asString(body.participant_version);
  if (!participantVersion) {
    return sendMissingField(reply, "overnight_agent_run_missing_required_field", "participant_version");
  }

  if (body.starting_cash === undefined || body.starting_cash === null) {
    return sendMissingField(reply, "overnight_agent_run_missing_required_field", "starting_cash");
  }

  const startingCash = readRequiredFiniteNumber(body, "starting_cash");
  if (!startingCash.ok || startingCash.value < 0) {
    return reply.code(400).send({
      error: "overnight_agent_run_invalid_field",
      field: "starting_cash",
      expected: "finite number greater than or equal to 0",
    });
  }

  const status = readDefaultedStringField(body, "status", "created");
  if (!status.ok) {
    return sendInvalidField(reply, "overnight_agent_run_invalid_field", status.field);
  }

  const sandboxPortfolioRef = readOptionalStringField(body, "sandbox_portfolio_ref");
  if (!sandboxPortfolioRef.ok) {
    return sendInvalidField(reply, "overnight_agent_run_invalid_field", sandboxPortfolioRef.field);
  }

  const actionTraceRef = readOptionalStringField(body, "action_trace_ref");
  if (!actionTraceRef.ok) {
    return sendInvalidField(reply, "overnight_agent_run_invalid_field", actionTraceRef.field);
  }

  const failureReason = readOptionalStringField(body, "failure_reason");
  if (!failureReason.ok) {
    return sendInvalidField(reply, "overnight_agent_run_invalid_field", failureReason.field);
  }

  const startedAt = readOptionalTimestamp(body, "started_at");
  if (!startedAt.ok) {
    return sendInvalidField(reply, "overnight_agent_run_invalid_field", startedAt.field);
  }

  const completedAt = readOptionalTimestamp(body, "completed_at");
  if (!completedAt.ok) {
    return sendInvalidField(reply, "overnight_agent_run_invalid_field", completedAt.field);
  }

  const run = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM overnight_sandbox_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId],
  );

  if ((run.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_run_not_found", field: "run_id" });
  }

  const agent = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM agents
      WHERE id = $1
      LIMIT 1
    `,
    [participantAgentId],
  );

  if ((agent.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_agent_not_found", field: "participant_agent_id" });
  }

  const result = await pool.query<OvernightAgentRunRow>(
    `
      INSERT INTO overnight_agent_runs (
        id,
        sandbox_run_id,
        participant_agent_id,
        participant_version,
        status,
        starting_cash,
        sandbox_portfolio_ref,
        action_trace_ref,
        scorecard_id,
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
        $6,
        $7,
        $8,
        $9,
        $10::timestamptz,
        $11::timestamptz,
        $12,
        NOW(),
        NOW()
      )
      RETURNING *
    `,
    [
      asString(body.id) ?? randomUUID(),
      runId,
      participantAgentId,
      participantVersion,
      status.value,
      startingCash.value,
      sandboxPortfolioRef.value,
      actionTraceRef.value,
      null,
      startedAt.value,
      completedAt.value,
      failureReason.value,
    ],
  );

  return reply.code(201).send({
    item: mapAgentRunRow(result.rows[0]),
  });
});

app.get("/v1/internal/overnight/runs/:runId/scorecards", async (request, reply) => {
  const runId = (request.params as { runId: string }).runId;
  const run = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM overnight_sandbox_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId],
  );

  if ((run.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_run_not_found", field: "run_id" });
  }

  const result = await pool.query<OvernightScorecardRow>(
    `
      SELECT *
      FROM overnight_scorecards
      WHERE sandbox_run_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [runId],
  );

  return {
    items: result.rows.map(mapScorecardRow),
  };
});

app.post("/v1/internal/overnight/runs/:runId/scorecards", async (request, reply) => {
  const runId = (request.params as { runId: string }).runId;
  const body = ensureObjectPayload(request.body);
  if (!body) {
    return sendInvalidBody(reply, "overnight_scorecard_invalid_body");
  }

  const agentRunId = readOptionalStringField(body, "agent_run_id");
  if (!agentRunId.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", agentRunId.field);
  }

  const scoreTotal = readOptionalFiniteNumber(body, "score_total");
  if (!scoreTotal.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", scoreTotal.field);
  }

  const scoreDimensions = readDefaultedJsonObjectField(body, "score_dimensions", {});
  if (!scoreDimensions.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", scoreDimensions.field);
  }

  const hardFailures = readDefaultedArrayField(body, "hard_failures");
  if (!hardFailures.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", hardFailures.field);
  }

  const softFailures = readDefaultedArrayField(body, "soft_failures");
  if (!softFailures.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", softFailures.field);
  }

  const verifierVersion = readDefaultedStringField(body, "verifier_version", "overnight-verifier@1");
  if (!verifierVersion.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", verifierVersion.field);
  }

  const inputManifestHash = readOptionalStringField(body, "input_manifest_hash");
  if (!inputManifestHash.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", inputManifestHash.field);
  }

  const scenarioHashes = readDefaultedArrayField(body, "scenario_hashes");
  if (!scenarioHashes.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", scenarioHashes.field);
  }

  const marketImpactLabel = readDefaultedStringField(
    body,
    "market_impact_label",
    "simulated_after_close",
  );
  if (!marketImpactLabel.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", marketImpactLabel.field);
  }

  const liveClaim = readDefaultedBooleanField(body, "live_claim", false);
  if (!liveClaim.ok) {
    return sendInvalidField(reply, "overnight_scorecard_invalid_field", liveClaim.field);
  }
  if (liveClaim.value) {
    return reply.code(400).send({ error: "overnight_scorecard_live_claim_forbidden" });
  }

  const run = await pool.query<SandboxRunCaseRow>(
    `
      SELECT
        runs.id,
        runs.case_bundle_id,
        cases.manifest_hash
      FROM overnight_sandbox_runs runs
      JOIN overnight_case_bundles cases ON cases.id = runs.case_bundle_id
      WHERE runs.id = $1
      LIMIT 1
    `,
    [runId],
  );

  if ((run.rowCount ?? 0) === 0) {
    return reply.code(404).send({ error: "overnight_run_not_found", field: "run_id" });
  }

  const runCase = run.rows[0];
  if (agentRunId.value) {
    const agentRun = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM overnight_agent_runs
        WHERE id = $1
          AND sandbox_run_id = $2
        LIMIT 1
      `,
      [agentRunId.value, runId],
    );

    if ((agentRun.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "overnight_agent_run_not_found", field: "agent_run_id" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<OvernightScorecardRow>(
      `
        INSERT INTO overnight_scorecards (
          id,
          sandbox_run_id,
          agent_run_id,
          case_bundle_id,
          score_total,
          score_dimensions,
          hard_failures,
          soft_failures,
          verifier_version,
          input_manifest_hash,
          scenario_hashes,
          market_impact_label,
          live_claim,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7::jsonb,
          $8::jsonb,
          $9,
          $10,
          $11::jsonb,
          $12,
          $13,
          NOW()
        )
        RETURNING *
      `,
      [
        asString(body.id) ?? randomUUID(),
        runId,
        agentRunId.value,
        runCase.case_bundle_id,
        scoreTotal.value,
        JSON.stringify(scoreDimensions.value),
        JSON.stringify(hardFailures.value),
        JSON.stringify(softFailures.value),
        verifierVersion.value,
        inputManifestHash.value ?? runCase.manifest_hash,
        JSON.stringify(scenarioHashes.value),
        marketImpactLabel.value,
        liveClaim.value,
      ],
    );

    if (agentRunId.value) {
      await client.query(
        `
          UPDATE overnight_agent_runs
          SET scorecard_id = $1,
              updated_at = NOW()
          WHERE id = $2
            AND sandbox_run_id = $3
        `,
        [result.rows[0].id, agentRunId.value, runId],
      );
    }

    await client.query("COMMIT");
    return reply.code(201).send({
      item: mapScorecardRow(result.rows[0]),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
