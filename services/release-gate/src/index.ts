import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  createDatabasePool,
  ensureCoreSchema,
  getDatabaseUrl,
  parseJsonField,
  toIsoTimestamp,
} from "@automakit/persistence";

type JsonObject = Record<string, unknown>;
type GateDecision = "not_run" | "passed" | "failed";
type GateRunStatus = "created" | "running" | "passed" | "failed";
type VerifierCheckStatus = "passed" | "failed";

type Queryable = Pick<Pool | PoolClient, "query">;

type SnapshotRow = {
  id: string;
  snapshot_key: string;
  gate_name: string;
  gate_version: string;
  candidate_kind: string;
  candidate_id: string;
  candidate_version: string;
  projection_runtime: string;
  semantic_facade_version: string;
  manifest: unknown;
  criteria: unknown;
  source_refs: unknown;
  created_by_agent_id: string | null;
  created_at: unknown;
};

type GateRunRow = {
  id: string;
  run_key: string;
  snapshot_id: string;
  projection_run_id: string | null;
  status: GateRunStatus;
  decision: GateDecision;
  gate_manifest: unknown;
  projection_result: unknown;
  decision_result: unknown;
  failure_reason: string | null;
  started_at: unknown;
  completed_at: unknown | null;
  created_at: unknown;
  updated_at: unknown;
};

type RolloutRow = {
  id: string;
  rollout_key: string;
  gate_run_id: string;
  snapshot_id: string;
  status: string;
  rollout_ordinal: unknown;
  seed: unknown;
  database_ref: string;
  object_store_prefix: string | null;
  fault_manifest: unknown;
  rollout_manifest: unknown;
  started_at: unknown | null;
  completed_at: unknown | null;
  created_at: unknown;
  updated_at: unknown;
};

type ToolCallRow = {
  id: string;
  gate_run_id: string;
  rollout_id: string | null;
  call_key: string;
  agent_id: string | null;
  tool_namespace: string;
  tool_name: string;
  semantic_facade_version: string;
  request_manifest: unknown;
  response_result: unknown;
  error_result: unknown | null;
  state_before_hash: string | null;
  state_after_hash: string | null;
  evidence_refs: unknown;
  status: string;
  started_at: unknown;
  completed_at: unknown | null;
  created_at: unknown;
};

type SemanticEventRow = {
  sequence_id: unknown;
  event_id: string;
  gate_run_id: string;
  rollout_id: string | null;
  tool_call_id: string | null;
  event_type: string;
  semantic_facade_version: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  occurred_at: unknown;
  created_at: unknown;
};

type PromotionArtifactRow = {
  id: string;
  artifact_key: string;
  gate_run_id: string;
  snapshot_id: string;
  candidate_kind: string;
  candidate_id: string;
  candidate_version: string;
  artifact_kind: string;
  status: string;
  content_hash: string;
  approved_scopes: unknown;
  risk_limits: unknown;
  manifest: unknown;
  criteria_result: unknown;
  verifier_summary: unknown;
  rollout_plan: unknown;
  issued_at: unknown;
  expires_at: unknown | null;
  created_at: unknown;
};

type GateRunSummaryRow = {
  run_id: string;
  run_key: string;
  snapshot_id: string;
  projection_run_id: string | null;
  status: GateRunStatus;
  decision: GateDecision;
  failure_reason: string | null;
  started_at: unknown;
  completed_at: unknown | null;
  updated_at: unknown;
  snapshot_key: string;
  gate_name: string;
  gate_version: string;
  candidate_kind: string;
  candidate_id: string;
  candidate_version: string;
  projection_runtime: string;
  semantic_facade_version: string;
  promotion_artifact_id: string | null;
  promotion_artifact_key: string | null;
  promotion_artifact_kind: string | null;
  promotion_artifact_status: string | null;
  promotion_artifact_issued_at: unknown | null;
  promotion_artifact_expires_at: unknown | null;
};

type VerifierCheck = {
  key: string;
  kind: string;
  status: VerifierCheckStatus;
  summary: string;
  violation_count: number;
  evidence: JsonObject[];
};

type VerifierResult = {
  status: GateDecision;
  verifier_version: string;
  checked_at: string;
  checks: VerifierCheck[];
};

type StringArraySetting = {
  present: boolean;
  values: string[];
  invalidValues: unknown[];
};

type DenialEventExpectation = {
  source: "criteria" | "gate_manifest";
  ordinal: number;
  tool_name?: string;
  execution_mode?: string;
  error?: string;
};

type DenialEventInvalidExpectation = {
  source: "criteria" | "gate_manifest";
  ordinal?: number;
  reason: string;
  value: unknown;
};

const execFileAsync = promisify(execFile);
const app = Fastify({ logger: true });
const pool = createDatabasePool();
const port = Number(process.env.RELEASE_GATE_SERVICE_PORT ?? 4016);
const verifierVersion = "release-gate-verifier@1";
const verifierTolerance = Math.max(0, Number(process.env.RELEASE_GATE_VERIFIER_TOLERANCE ?? 1e-9));
const verifierEvidenceLimit = Math.max(1, Number(process.env.RELEASE_GATE_VERIFIER_EVIDENCE_LIMIT ?? 25));
const rolloutCloneTimeoutMs = Math.max(1000, Number(process.env.RELEASE_GATE_ROLLOUT_CLONE_TIMEOUT_MS ?? 30_000));
const defaultRequiredToolNames = ["portfolio.get", "orders.submit", "orders.cancel", "orders.get", "fills.list"];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as JsonObject)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function parseJsonObject(value: unknown): JsonObject {
  const parsed = parseJsonField<unknown>(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJsonField<unknown>(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseStringArray(value: unknown): string[] {
  return parseJsonArray(value).filter((entry): entry is string => typeof entry === "string");
}

function hasOwnProperty(value: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readStringArraySetting(source: JsonObject, key: string): StringArraySetting {
  if (!hasOwnProperty(source, key)) {
    return { present: false, values: [], invalidValues: [] };
  }
  const value = source[key];
  if (!Array.isArray(value)) {
    return { present: true, values: [], invalidValues: [value] };
  }
  const values = value.filter((entry): entry is string => typeof entry === "string");
  return {
    present: true,
    values,
    invalidValues: value.filter((entry) => typeof entry !== "string"),
  };
}

function resolveRequiredToolNames(gateManifest: JsonObject, criteria: JsonObject) {
  const manifestTools = readStringArraySetting(gateManifest, "required_tool_names");
  if (manifestTools.present) {
    return manifestTools;
  }
  const criteriaTools = readStringArraySetting(criteria, "required_tool_names");
  if (criteriaTools.present) {
    return criteriaTools;
  }
  return {
    present: false,
    values: defaultRequiredToolNames,
    invalidValues: [],
  };
}

function readDenialEventExpectations(
  sourceName: "criteria" | "gate_manifest",
  source: JsonObject,
) {
  if (!hasOwnProperty(source, "required_denial_events")) {
    return {
      present: false,
      expectations: [] as DenialEventExpectation[],
      invalid: [] as DenialEventInvalidExpectation[],
    };
  }

  const value = source.required_denial_events;
  if (!Array.isArray(value)) {
    return {
      present: true,
      expectations: [] as DenialEventExpectation[],
      invalid: [{
        source: sourceName,
        reason: "required_denial_events_must_be_array",
        value,
      }] as DenialEventInvalidExpectation[],
    };
  }

  const expectations: DenialEventExpectation[] = [];
  const invalid: DenialEventInvalidExpectation[] = [];
  value.forEach((entry, index) => {
    const ordinal = index + 1;
    if (!isJsonObject(entry)) {
      invalid.push({
        source: sourceName,
        ordinal,
        reason: "required_denial_event_must_be_object",
        value: entry,
      });
      return;
    }

    const unknownFields = Object.entries(entry)
      .filter(([key, nested]) => ["tool_name", "execution_mode", "error"].includes(key) && typeof nested !== "string")
      .map(([key, nested]) => ({ field: key, value: nested }));
    if (unknownFields.length > 0) {
      invalid.push({
        source: sourceName,
        ordinal,
        reason: "required_denial_event_match_fields_must_be_strings",
        value: { fields: unknownFields },
      });
      return;
    }

    expectations.push({
      source: sourceName,
      ordinal,
      tool_name: typeof entry.tool_name === "string" ? entry.tool_name : undefined,
      execution_mode: typeof entry.execution_mode === "string" ? entry.execution_mode : undefined,
      error: typeof entry.error === "string" ? entry.error : undefined,
    });
  });

  return {
    present: true,
    expectations,
    invalid,
  };
}

function resolveRequiredDenialEvents(gateManifest: JsonObject, criteria: JsonObject) {
  const criteriaEvents = readDenialEventExpectations("criteria", criteria);
  const manifestEvents = readDenialEventExpectations("gate_manifest", gateManifest);
  return {
    present: criteriaEvents.present || manifestEvents.present,
    expectations: [...criteriaEvents.expectations, ...manifestEvents.expectations],
    invalid: [...criteriaEvents.invalid, ...manifestEvents.invalid],
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function invalidStringArrayEvidence(settingName: string, invalidValues: unknown[]) {
  return invalidValues.map((value, index) => ({
    setting: settingName,
    ordinal: index + 1,
    reason: "expected_string_value",
    value,
  }));
}

function optionalIso(value: unknown) {
  return value === null || value === undefined ? null : toIsoTimestamp(value);
}

function sanitizeIdentifierFragment(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "gate";
}

function buildRolloutDatabaseName(gateRunId: string, rolloutOrdinal: number) {
  const prefix = sanitizeIdentifierFragment(process.env.RELEASE_GATE_ROLLOUT_DATABASE_PREFIX ?? "automakit_gate");
  const suffix = sanitizeIdentifierFragment(gateRunId).slice(0, 32);
  return `${prefix}_${suffix}_${rolloutOrdinal}`;
}

function buildRolloutDatabaseUrl(sourceDatabaseUrl: string, databaseName: string) {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function mapSnapshot(row: SnapshotRow) {
  return {
    id: row.id,
    snapshot_key: row.snapshot_key,
    gate_name: row.gate_name,
    gate_version: row.gate_version,
    candidate_kind: row.candidate_kind,
    candidate_id: row.candidate_id,
    candidate_version: row.candidate_version,
    projection_runtime: row.projection_runtime,
    semantic_facade_version: row.semantic_facade_version,
    manifest: parseJsonObject(row.manifest),
    criteria: parseJsonObject(row.criteria),
    source_refs: parseJsonArray(row.source_refs),
    created_by_agent_id: row.created_by_agent_id,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapGateRun(row: GateRunRow) {
  return {
    id: row.id,
    run_key: row.run_key,
    snapshot_id: row.snapshot_id,
    projection_run_id: row.projection_run_id,
    status: row.status,
    decision: row.decision,
    gate_manifest: parseJsonObject(row.gate_manifest),
    projection_result: parseJsonObject(row.projection_result),
    decision_result: parseJsonObject(row.decision_result),
    failure_reason: row.failure_reason,
    started_at: toIsoTimestamp(row.started_at),
    completed_at: optionalIso(row.completed_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function mapRollout(row: RolloutRow) {
  return {
    id: row.id,
    rollout_key: row.rollout_key,
    gate_run_id: row.gate_run_id,
    snapshot_id: row.snapshot_id,
    status: row.status,
    rollout_ordinal: Number(row.rollout_ordinal),
    seed: Number(row.seed),
    database_ref: row.database_ref,
    object_store_prefix: row.object_store_prefix,
    fault_manifest: parseJsonObject(row.fault_manifest),
    rollout_manifest: parseJsonObject(row.rollout_manifest),
    started_at: optionalIso(row.started_at),
    completed_at: optionalIso(row.completed_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function mapToolCall(row: ToolCallRow) {
  return {
    id: row.id,
    gate_run_id: row.gate_run_id,
    rollout_id: row.rollout_id,
    call_key: row.call_key,
    agent_id: row.agent_id,
    tool_namespace: row.tool_namespace,
    tool_name: row.tool_name,
    semantic_facade_version: row.semantic_facade_version,
    request_manifest: parseJsonObject(row.request_manifest),
    response_result: parseJsonObject(row.response_result),
    error_result: row.error_result ? parseJsonObject(row.error_result) : null,
    state_before_hash: row.state_before_hash,
    state_after_hash: row.state_after_hash,
    evidence_refs: parseJsonArray(row.evidence_refs),
    status: row.status,
    started_at: toIsoTimestamp(row.started_at),
    completed_at: optionalIso(row.completed_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapSemanticEvent(row: SemanticEventRow) {
  return {
    sequence_id: Number(row.sequence_id),
    event_id: row.event_id,
    gate_run_id: row.gate_run_id,
    rollout_id: row.rollout_id,
    tool_call_id: row.tool_call_id,
    event_type: row.event_type,
    semantic_facade_version: row.semantic_facade_version,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    payload: parseJsonObject(row.payload),
    occurred_at: toIsoTimestamp(row.occurred_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapPromotionArtifact(row: PromotionArtifactRow) {
  return {
    id: row.id,
    artifact_key: row.artifact_key,
    gate_run_id: row.gate_run_id,
    snapshot_id: row.snapshot_id,
    candidate_kind: row.candidate_kind,
    candidate_id: row.candidate_id,
    candidate_version: row.candidate_version,
    artifact_kind: row.artifact_kind,
    status: row.status,
    content_hash: row.content_hash,
    approved_scopes: parseStringArray(row.approved_scopes),
    risk_limits: parseJsonObject(row.risk_limits),
    manifest: parseJsonObject(row.manifest),
    criteria_result: parseJsonObject(row.criteria_result),
    verifier_summary: parseJsonObject(row.verifier_summary),
    rollout_plan: parseJsonObject(row.rollout_plan),
    issued_at: toIsoTimestamp(row.issued_at),
    expires_at: optionalIso(row.expires_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapGateRunSummary(row: GateRunSummaryRow) {
  return {
    id: row.run_id,
    run_key: row.run_key,
    snapshot_id: row.snapshot_id,
    projection_run_id: row.projection_run_id,
    status: row.status,
    decision: row.decision,
    failure_reason: row.failure_reason,
    started_at: toIsoTimestamp(row.started_at),
    completed_at: optionalIso(row.completed_at),
    updated_at: toIsoTimestamp(row.updated_at),
    snapshot: {
      id: row.snapshot_id,
      snapshot_key: row.snapshot_key,
      gate_name: row.gate_name,
      gate_version: row.gate_version,
      candidate_kind: row.candidate_kind,
      candidate_id: row.candidate_id,
      candidate_version: row.candidate_version,
      projection_runtime: row.projection_runtime,
      semantic_facade_version: row.semantic_facade_version,
    },
    promotion_artifact: row.promotion_artifact_id
      ? {
          id: row.promotion_artifact_id,
          artifact_key: row.promotion_artifact_key,
          artifact_kind: row.promotion_artifact_kind,
          status: row.promotion_artifact_status,
          issued_at: optionalIso(row.promotion_artifact_issued_at),
          expires_at: optionalIso(row.promotion_artifact_expires_at),
        }
      : null,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildCheck(key: string, kind: string, rows: JsonObject[], passed: string, failed: string): VerifierCheck {
  return {
    key,
    kind,
    status: rows.length === 0 ? "passed" : "failed",
    summary: rows.length === 0 ? passed : failed,
    violation_count: rows.length,
    evidence: rows,
  };
}

async function insertSemanticEvent(
  client: Queryable,
  input: {
    gateRunId: string;
    rolloutId?: string | null;
    toolCallId?: string | null;
    semanticFacadeVersion: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
  },
) {
  await client.query(
    `
      INSERT INTO release_gate_semantic_events (
        event_id,
        gate_run_id,
        rollout_id,
        tool_call_id,
        event_type,
        semantic_facade_version,
        aggregate_type,
        aggregate_id,
        payload,
        occurred_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
    `,
    [
      randomUUID(),
      input.gateRunId,
      input.rolloutId ?? null,
      input.toolCallId ?? null,
      input.eventType,
      input.semanticFacadeVersion,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload),
    ],
  );
}

async function getSnapshot(client: Queryable, snapshotId: string) {
  const result = await client.query<SnapshotRow>(
    "SELECT * FROM release_gate_snapshots WHERE id = $1",
    [snapshotId],
  );
  return result.rowCount ? result.rows[0] : null;
}

async function getGateRunWithSnapshot(client: Queryable, runId: string) {
  const result = await client.query<GateRunRow & SnapshotRow & { run_id: string; gate_run_status: GateRunStatus }>(
    `
      SELECT
        gr.id AS run_id,
        gr.run_key,
        gr.snapshot_id,
        gr.projection_run_id,
        gr.status AS gate_run_status,
        gr.decision,
        gr.gate_manifest,
        gr.projection_result,
        gr.decision_result,
        gr.failure_reason,
        gr.started_at,
        gr.completed_at,
        gr.created_at,
        gr.updated_at,
        s.*
      FROM release_gate_runs gr
      JOIN release_gate_snapshots s ON s.id = gr.snapshot_id
      WHERE gr.id = $1
    `,
    [runId],
  );
  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0];
  return {
    gateRun: {
      id: row.run_id,
      run_key: row.run_key,
      snapshot_id: row.snapshot_id,
      projection_run_id: row.projection_run_id,
      status: row.gate_run_status,
      decision: row.decision,
      gate_manifest: row.gate_manifest,
      projection_result: row.projection_result,
      decision_result: row.decision_result,
      failure_reason: row.failure_reason,
      started_at: row.started_at,
      completed_at: row.completed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } satisfies GateRunRow,
    snapshot: row,
  };
}

async function getGateRunDetails(client: Queryable, runId: string) {
  const joined = await getGateRunWithSnapshot(client, runId);
  if (!joined) {
    return null;
  }

  const [rollouts, toolCalls, events, artifacts] = await Promise.all([
    client.query<RolloutRow>(
      "SELECT * FROM release_gate_rollouts WHERE gate_run_id = $1 ORDER BY rollout_ordinal ASC, created_at ASC",
      [runId],
    ),
    client.query<ToolCallRow>(
      "SELECT * FROM release_gate_tool_calls WHERE gate_run_id = $1 ORDER BY created_at ASC, id ASC",
      [runId],
    ),
    client.query<SemanticEventRow>(
      "SELECT * FROM release_gate_semantic_events WHERE gate_run_id = $1 ORDER BY sequence_id ASC",
      [runId],
    ),
    client.query<PromotionArtifactRow>(
      "SELECT * FROM release_gate_promotion_artifacts WHERE gate_run_id = $1 ORDER BY issued_at DESC, id DESC",
      [runId],
    ),
  ]);

  return {
    ...mapGateRun(joined.gateRun),
    snapshot: mapSnapshot(joined.snapshot),
    rollouts: rollouts.rows.map(mapRollout),
    tool_calls: toolCalls.rows.map(mapToolCall),
    semantic_events: events.rows.map(mapSemanticEvent),
    promotion_artifacts: artifacts.rows.map(mapPromotionArtifact),
  };
}

async function cloneRolloutDatabase(input: {
  gateRunId: string;
  rolloutId: string;
  sourceDatabaseUrl: string;
  rolloutDatabaseName: string;
}) {
  const command = process.env.RELEASE_GATE_ROLLOUT_CLONE_COMMAND;
  const template = process.env.RELEASE_GATE_ROLLOUT_TEMPLATE_DATABASE;
  if (!command || !template) {
    throw new Error("release_gate_rollout_clone_not_configured");
  }

  const { stdout, stderr } = await execFileAsync(command, [input.rolloutDatabaseName], {
    timeout: rolloutCloneTimeoutMs,
    env: {
      ...process.env,
      RELEASE_GATE_RUN_ID: input.gateRunId,
      RELEASE_GATE_ROLLOUT_ID: input.rolloutId,
      RELEASE_GATE_SOURCE_DATABASE_URL: input.sourceDatabaseUrl,
      RELEASE_GATE_ROLLOUT_DATABASE_NAME: input.rolloutDatabaseName,
      RELEASE_GATE_ROLLOUT_TEMPLATE_DATABASE: template,
    },
  });

  return {
    command,
    template,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function verifyReservedBalancesNonnegative(client: Queryable): Promise<VerifierCheck> {
  const result = await client.query<JsonObject>(
    `
      SELECT *
      FROM (
        SELECT 'portfolio_accounts' AS source_table, agent_id, NULL::text AS market_id, NULL::text AS outcome, reserved_cash AS reserved_value
        FROM portfolio_accounts
        WHERE reserved_cash < -$1
        UNION ALL
        SELECT 'portfolio_positions' AS source_table, agent_id, market_id, outcome, reserved_quantity AS reserved_value
        FROM portfolio_positions
        WHERE reserved_quantity < -$1
      ) violations
      ORDER BY source_table, agent_id, market_id, outcome
      LIMIT $2
    `,
    [verifierTolerance, verifierEvidenceLimit],
  );
  return buildCheck(
    "reserved_balances_nonnegative",
    "resource",
    result.rows,
    "No negative reserved cash or reserved position balances were found.",
    "Negative reserved balances were found.",
  );
}

async function verifyOrderReservationLedgerLinkage(client: Queryable): Promise<VerifierCheck> {
  const result = await client.query<JsonObject>(
    `
      SELECT o.id AS order_id, o.agent_id, o.market_id, o.side, o.outcome, o.price, o.size, o.status
      FROM orders o
      LEFT JOIN portfolio_ledger_entries le
        ON le.reference_type = 'order_reserve'
        AND le.reference_id = o.id
        AND le.agent_id = o.agent_id
        AND le.market_id = o.market_id
        AND COALESCE(le.outcome, '') = o.outcome
        AND (
          (o.side = 'buy' AND le.entry_type = 'reserve_cash' AND le.reserved_cash_delta >= (o.price * o.size) - $1)
          OR
          (o.side = 'sell' AND le.entry_type = 'reserve_position' AND le.reserved_position_delta >= o.size - $1)
        )
      WHERE le.id IS NULL
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $2
    `,
    [verifierTolerance, verifierEvidenceLimit],
  );
  return buildCheck(
    "orders_have_reservation_ledger_linkage",
    "resource",
    result.rows,
    "Every order has a matching reservation ledger entry.",
    "Some orders are missing reservation ledger entries.",
  );
}

async function verifyCanceledOrderReleaseLedgerLinkage(client: Queryable): Promise<VerifierCheck> {
  const result = await client.query<JsonObject>(
    `
      SELECT o.id AS order_id, o.agent_id, o.market_id, o.side, o.outcome, o.price, o.size, o.filled_size
      FROM orders o
      LEFT JOIN portfolio_ledger_entries le
        ON le.reference_type = 'order_cancel'
        AND le.reference_id = o.id
        AND le.agent_id = o.agent_id
        AND le.market_id = o.market_id
        AND COALESCE(le.outcome, '') = o.outcome
        AND (
          (
            o.side = 'buy'
            AND le.entry_type = 'cancel_release_cash'
            AND le.reserved_cash_delta <= -((o.price * GREATEST(o.size - o.filled_size, 0)) - $1)
          )
          OR (
            o.side = 'sell'
            AND le.entry_type = 'cancel_release_position'
            AND le.reserved_position_delta <= -(GREATEST(o.size - o.filled_size, 0) - $1)
          )
        )
      WHERE o.status = 'canceled'
        AND GREATEST(o.size - o.filled_size, 0) > $1
        AND le.id IS NULL
      ORDER BY o.updated_at DESC, o.id DESC
      LIMIT $2
    `,
    [verifierTolerance, verifierEvidenceLimit],
  );
  return buildCheck(
    "canceled_orders_have_release_ledger_linkage",
    "resource",
    result.rows,
    "Every canceled order with remaining size has a matching release ledger entry.",
    "Some canceled orders are missing release ledger entries.",
  );
}

async function verifyFillsReferenceOrders(client: Queryable): Promise<VerifierCheck> {
  const result = await client.query<JsonObject>(
    `
      SELECT
        f.id AS fill_id,
        f.market_id,
        f.outcome,
        f.buy_order_id,
        f.sell_order_id,
        f.buy_agent_id,
        f.sell_agent_id
      FROM fills f
      LEFT JOIN orders bo ON bo.id = f.buy_order_id
      LEFT JOIN orders so ON so.id = f.sell_order_id
      WHERE bo.id IS NULL
        OR so.id IS NULL
        OR bo.market_id <> f.market_id
        OR so.market_id <> f.market_id
        OR bo.outcome <> f.outcome
        OR so.outcome <> f.outcome
        OR bo.agent_id <> f.buy_agent_id
        OR so.agent_id <> f.sell_agent_id
        OR bo.side <> 'buy'
        OR so.side <> 'sell'
      ORDER BY f.executed_at DESC, f.id DESC
      LIMIT $1
    `,
    [verifierEvidenceLimit],
  );
  return buildCheck(
    "fills_reference_valid_orders",
    "terminal_state",
    result.rows,
    "Every fill references matching buy and sell orders.",
    "Some fills reference missing or mismatched orders.",
  );
}

async function verifyFillsHaveLedgerLinkage(client: Queryable): Promise<VerifierCheck> {
  const result = await client.query<JsonObject>(
    `
      SELECT f.id AS fill_id, f.market_id, f.outcome, f.price, f.size, f.buy_agent_id, f.sell_agent_id
      FROM fills f
      LEFT JOIN portfolio_ledger_entries buy_le
        ON buy_le.reference_type = 'fill'
        AND buy_le.reference_id = f.id
        AND buy_le.agent_id = f.buy_agent_id
        AND buy_le.market_id = f.market_id
        AND COALESCE(buy_le.outcome, '') = f.outcome
        AND buy_le.entry_type = 'fill_buy'
        AND buy_le.position_delta >= f.size - $1
      LEFT JOIN portfolio_ledger_entries sell_le
        ON sell_le.reference_type = 'fill'
        AND sell_le.reference_id = f.id
        AND sell_le.agent_id = f.sell_agent_id
        AND sell_le.market_id = f.market_id
        AND COALESCE(sell_le.outcome, '') = f.outcome
        AND sell_le.entry_type = 'fill_sell'
        AND sell_le.position_delta <= -(f.size - $1)
      WHERE buy_le.id IS NULL OR sell_le.id IS NULL
      ORDER BY f.executed_at DESC, f.id DESC
      LIMIT $2
    `,
    [verifierTolerance, verifierEvidenceLimit],
  );
  return buildCheck(
    "fills_have_portfolio_ledger_linkage",
    "terminal_state",
    result.rows,
    "Every fill has buyer and seller ledger entries.",
    "Some fills are missing buyer or seller ledger entries.",
  );
}

async function verifyPromotionArtifactsIssuedAfterPass(client: Queryable): Promise<VerifierCheck> {
  const result = await client.query<JsonObject>(
    `
      SELECT pa.id AS promotion_artifact_id, pa.gate_run_id, pa.candidate_id, pa.status, gr.decision
      FROM release_gate_promotion_artifacts pa
      JOIN release_gate_runs gr ON gr.id = pa.gate_run_id
      WHERE pa.status = 'issued'
        AND gr.decision <> 'passed'
      ORDER BY pa.issued_at DESC, pa.id DESC
      LIMIT $1
    `,
    [verifierEvidenceLimit],
  );
  return buildCheck(
    "promotion_artifacts_issued_only_after_pass",
    "promotion",
    result.rows,
    "No issued promotion artifact exists for a non-passing gate run.",
    "Issued promotion artifacts exist for non-passing gate runs.",
  );
}

async function verifyRequiredToolCoverage(
  client: Queryable,
  gateRunId: string,
  gateManifest: JsonObject,
  criteria: JsonObject,
): Promise<VerifierCheck> {
  const required = resolveRequiredToolNames(gateManifest, criteria);
  const requiredToolNames = uniqueStrings(required.values);
  const result = await client.query<{ tool_name: string; call_count: string }>(
    `
      SELECT tool_name, COUNT(*)::text AS call_count
      FROM release_gate_tool_calls
      WHERE gate_run_id = $1
      GROUP BY tool_name
      ORDER BY tool_name ASC
    `,
    [gateRunId],
  );
  const observedToolNames = new Set(result.rows.map((row) => row.tool_name));
  const missingTools = requiredToolNames
    .filter((toolName) => !observedToolNames.has(toolName))
    .map((toolName) => ({
      tool_name: toolName,
      reason: "required_tool_not_called",
    }));
  const invalidValues = invalidStringArrayEvidence("required_tool_names", required.invalidValues);
  const evidence = [...invalidValues, ...missingTools];

  return {
    key: "gate_required_tool_coverage",
    kind: "tool_coverage",
    status: evidence.length === 0 ? "passed" : "failed",
    summary: evidence.length === 0
      ? `Gate run covered ${requiredToolNames.length} required semantic facade tools.`
      : "Gate run is missing required semantic facade tool coverage.",
    violation_count: evidence.length,
    evidence,
  };
}

async function verifyStateHashCoverage(
  client: Queryable,
  gateRunId: string,
  criteria: JsonObject,
): Promise<VerifierCheck> {
  const optional = readStringArraySetting(criteria, "state_hash_optional_tool_names");
  const optionalToolNames = uniqueStrings(optional.values);
  const result = await client.query<JsonObject>(
    `
      SELECT
        id AS tool_call_id,
        call_key,
        agent_id,
        tool_namespace,
        tool_name,
        status,
        state_before_hash IS NULL AS missing_state_before_hash,
        state_after_hash IS NULL AS missing_state_after_hash,
        started_at,
        completed_at
      FROM release_gate_tool_calls
      WHERE gate_run_id = $1
        AND NOT (tool_name = ANY($2::text[]))
        AND (state_before_hash IS NULL OR state_after_hash IS NULL)
      ORDER BY started_at ASC, id ASC
      LIMIT $3
    `,
    [gateRunId, optionalToolNames, verifierEvidenceLimit],
  );
  const invalidValues = invalidStringArrayEvidence("state_hash_optional_tool_names", optional.invalidValues);
  const evidence = [...invalidValues, ...result.rows];

  return {
    key: "gate_tool_calls_have_state_hashes",
    kind: "state_hash",
    status: evidence.length === 0 ? "passed" : "failed",
    summary: evidence.length === 0
      ? "Every non-exempt gate tool call has before and after state hashes."
      : "Some non-exempt gate tool calls are missing before or after state hashes.",
    violation_count: evidence.length,
    evidence,
  };
}

async function verifyFailedToolCalls(
  client: Queryable,
  gateRunId: string,
  criteria: JsonObject,
): Promise<VerifierCheck> {
  const allowed = readStringArraySetting(criteria, "allowed_failed_tool_names");
  const allowedToolNames = uniqueStrings(allowed.values);
  const result = await client.query<JsonObject>(
    `
      SELECT
        id AS tool_call_id,
        call_key,
        agent_id,
        tool_namespace,
        tool_name,
        status,
        error_result,
        started_at,
        completed_at
      FROM release_gate_tool_calls
      WHERE gate_run_id = $1
        AND status = 'failed'
        AND NOT (tool_name = ANY($2::text[]))
      ORDER BY started_at ASC, id ASC
      LIMIT $3
    `,
    [gateRunId, allowedToolNames, verifierEvidenceLimit],
  );
  const invalidValues = invalidStringArrayEvidence("allowed_failed_tool_names", allowed.invalidValues);
  const evidence = [...invalidValues, ...result.rows];

  return {
    key: "gate_has_no_unexpected_failed_tool_calls",
    kind: "tool_result",
    status: evidence.length === 0 ? "passed" : "failed",
    summary: evidence.length === 0
      ? "No unexpected failed gate tool calls were recorded."
      : "Unexpected failed gate tool calls were recorded.",
    violation_count: evidence.length,
    evidence,
  };
}

async function verifyRequiredDenialEvents(
  client: Queryable,
  gateRun: GateRunRow,
  snapshot: SnapshotRow,
  gateManifest: JsonObject,
  criteria: JsonObject,
): Promise<VerifierCheck> {
  const required = resolveRequiredDenialEvents(gateManifest, criteria);
  if (!required.present) {
    return {
      key: "gate_required_denial_events_observed",
      kind: "risk_denial",
      status: "passed",
      summary: "No denial events are required for this gate run.",
      violation_count: 0,
      evidence: [],
    };
  }

  const evidence: JsonObject[] = required.invalid.map((entry) => entry as JsonObject);
  for (const expectation of required.expectations) {
    const result = await client.query<JsonObject>(
      `
        SELECT
          sequence_id,
          event_id,
          agent_id,
          market_id,
          payload,
          created_at
        FROM stream_events
        WHERE channel = 'release_gate.live_write_denied'
          AND agent_id = $1
          AND created_at >= $2
          AND created_at <= COALESCE($3::timestamptz, NOW())
          AND ($4::text IS NULL OR payload->>'tool_name' = $4)
          AND ($5::text IS NULL OR payload->>'execution_mode' = $5)
          AND ($6::text IS NULL OR payload->'denial'->>'error' = $6)
        ORDER BY created_at ASC, sequence_id ASC
        LIMIT 1
      `,
      [
        snapshot.candidate_id,
        gateRun.started_at,
        gateRun.completed_at,
        expectation.tool_name ?? null,
        expectation.execution_mode ?? null,
        expectation.error ?? null,
      ],
    );

    if (result.rowCount === 0) {
      evidence.push({
        ...expectation,
        reason: "required_denial_event_not_observed",
      });
    } else {
      evidence.push({
        ...expectation,
        matched_event: result.rows[0],
      });
    }
  }

  const violations = evidence.filter((entry) => !("matched_event" in entry));
  return {
    key: "gate_required_denial_events_observed",
    kind: "risk_denial",
    status: violations.length === 0 ? "passed" : "failed",
    summary: violations.length === 0
      ? "All required live-write denial events were observed for the candidate agent."
      : "Some required live-write denial events were not observed for the candidate agent.",
    violation_count: violations.length,
    evidence,
  };
}

async function runDeterministicVerifier(
  client: Queryable,
  gateRun: GateRunRow,
  snapshot: SnapshotRow,
): Promise<VerifierResult> {
  const gateManifest = parseJsonObject(gateRun.gate_manifest);
  const criteria = parseJsonObject(snapshot.criteria);
  const checks = [
    await verifyRequiredToolCoverage(client, gateRun.id, gateManifest, criteria),
    await verifyStateHashCoverage(client, gateRun.id, criteria),
    await verifyFailedToolCalls(client, gateRun.id, criteria),
    await verifyRequiredDenialEvents(client, gateRun, snapshot, gateManifest, criteria),
    await verifyReservedBalancesNonnegative(client),
    await verifyOrderReservationLedgerLinkage(client),
    await verifyCanceledOrderReleaseLedgerLinkage(client),
    await verifyFillsReferenceOrders(client),
    await verifyFillsHaveLedgerLinkage(client),
    await verifyPromotionArtifactsIssuedAfterPass(client),
  ];
  return {
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    verifier_version: verifierVersion,
    checked_at: new Date().toISOString(),
    checks,
  };
}

async function persistVerifierChecks(client: Queryable, gateRunId: string, verifierResult: VerifierResult) {
  for (const check of verifierResult.checks) {
    await client.query(
      `
        INSERT INTO release_gate_verifier_checks (
          id,
          gate_run_id,
          verifier_key,
          verifier_version,
          check_kind,
          status,
          hidden,
          score,
          threshold,
          expected_result,
          observed_result,
          evidence,
          error_result,
          started_at,
          completed_at,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, false, NULL, NULL, '{}'::jsonb, $7::jsonb, $8::jsonb, NULL, NOW(), NOW(), NOW())
        ON CONFLICT (gate_run_id, verifier_key) DO UPDATE
        SET status = EXCLUDED.status,
            observed_result = EXCLUDED.observed_result,
            evidence = EXCLUDED.evidence,
            completed_at = NOW()
      `,
      [
        randomUUID(),
        gateRunId,
        check.key,
        verifierResult.verifier_version,
        check.kind,
        check.status,
        JSON.stringify({ summary: check.summary, violation_count: check.violation_count }),
        JSON.stringify(check.evidence),
      ],
    );
  }
}

async function createPromotionArtifact(
  client: Queryable,
  input: {
    gateRun: GateRunRow;
    snapshot: SnapshotRow;
    verifierResult: VerifierResult;
    approvedScopes: string[];
    riskLimits: JsonObject;
    expiresAt?: string;
    artifactKind?: string;
    rolloutPlan?: JsonObject;
    manifest?: JsonObject;
  },
) {
  if (input.verifierResult.status !== "passed") {
    throw new Error("promotion_artifact_requires_passed_verifier");
  }

  const artifactKind = input.artifactKind ?? "live_scope_promotion";
  const manifest = {
    gate_run_id: input.gateRun.id,
    snapshot_id: input.snapshot.id,
    gate_name: input.snapshot.gate_name,
    gate_version: input.snapshot.gate_version,
    candidate_kind: input.snapshot.candidate_kind,
    candidate_id: input.snapshot.candidate_id,
    candidate_version: input.snapshot.candidate_version,
    semantic_facade_version: input.snapshot.semantic_facade_version,
    ...(input.manifest ?? {}),
  };
  const contentHash = sha256(stableStringify({
    manifest,
    approved_scopes: input.approvedScopes,
    risk_limits: input.riskLimits,
    verifier_summary: input.verifierResult,
  }));

  const result = await client.query<PromotionArtifactRow>(
    `
      INSERT INTO release_gate_promotion_artifacts (
        id,
        artifact_key,
        gate_run_id,
        snapshot_id,
        candidate_kind,
        candidate_id,
        candidate_version,
        artifact_kind,
        status,
        content_hash,
        approved_scopes,
        risk_limits,
        manifest,
        criteria_result,
        verifier_summary,
        rollout_plan,
        issued_at,
        expires_at,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'issued', $9,
        $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
        NOW(), $16::timestamptz, NOW()
      )
      ON CONFLICT (gate_run_id, artifact_kind) DO UPDATE
      SET status = 'issued',
          content_hash = EXCLUDED.content_hash,
          approved_scopes = EXCLUDED.approved_scopes,
          risk_limits = EXCLUDED.risk_limits,
          manifest = EXCLUDED.manifest,
          criteria_result = EXCLUDED.criteria_result,
          verifier_summary = EXCLUDED.verifier_summary,
          rollout_plan = EXCLUDED.rollout_plan,
          issued_at = NOW(),
          expires_at = EXCLUDED.expires_at
      RETURNING *
    `,
    [
      randomUUID(),
      `${input.gateRun.id}:${artifactKind}`,
      input.gateRun.id,
      input.snapshot.id,
      input.snapshot.candidate_kind,
      input.snapshot.candidate_id,
      input.snapshot.candidate_version,
      artifactKind,
      contentHash,
      JSON.stringify(input.approvedScopes),
      JSON.stringify(input.riskLimits),
      JSON.stringify(manifest),
      JSON.stringify({ decision: input.verifierResult.status }),
      JSON.stringify(input.verifierResult),
      JSON.stringify(input.rolloutPlan ?? {}),
      input.expiresAt ?? null,
    ],
  );
  return mapPromotionArtifact(result.rows[0]);
}

app.get("/health", async () => ({ service: "release-gate", status: "ok" }));

app.get("/v1/internal/release-gate/runs", async (request) => {
  const query = request.query as { limit?: string };
  const parsedLimit = Number(query.limit ?? 25);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, Math.floor(parsedLimit))) : 25;
  const result = await pool.query<GateRunSummaryRow>(
    `
      SELECT
        gr.id AS run_id,
        gr.run_key,
        gr.snapshot_id,
        gr.projection_run_id,
        gr.status,
        gr.decision,
        gr.failure_reason,
        gr.started_at,
        gr.completed_at,
        gr.updated_at,
        s.snapshot_key,
        s.gate_name,
        s.gate_version,
        s.candidate_kind,
        s.candidate_id,
        s.candidate_version,
        s.projection_runtime,
        s.semantic_facade_version,
        pa.id AS promotion_artifact_id,
        pa.artifact_key AS promotion_artifact_key,
        pa.artifact_kind AS promotion_artifact_kind,
        pa.status AS promotion_artifact_status,
        pa.issued_at AS promotion_artifact_issued_at,
        pa.expires_at AS promotion_artifact_expires_at
      FROM release_gate_runs gr
      JOIN release_gate_snapshots s ON s.id = gr.snapshot_id
      LEFT JOIN LATERAL (
        SELECT id, artifact_key, artifact_kind, status, issued_at, expires_at
        FROM release_gate_promotion_artifacts
        WHERE gate_run_id = gr.id
        ORDER BY issued_at DESC, id DESC
        LIMIT 1
      ) pa ON TRUE
      ORDER BY gr.updated_at DESC, gr.started_at DESC, gr.id DESC
      LIMIT $1
    `,
    [limit],
  );

  return {
    items: result.rows.map(mapGateRunSummary),
  };
});

app.post("/v1/internal/release-gate/runs", async (request, reply) => {
  const body = (request.body ?? {}) as {
    snapshot_id?: string;
    snapshot_key?: string;
    gate_name?: string;
    gate_version?: string;
    candidate_kind?: string;
    candidate_id?: string;
    candidate_version?: string;
    projection_runtime?: string;
    semantic_facade_version?: string;
    manifest?: unknown;
    criteria?: unknown;
    source_refs?: unknown;
    created_by_agent_id?: string;
    run_key?: string;
    gate_manifest?: unknown;
    projection_run_id?: string;
    rollout_count?: number;
    rollout_seeds?: number[];
    object_store_prefix?: string;
    fault_manifest?: unknown;
    rollout_manifest?: unknown;
    create_rollout_clone?: boolean;
    source_database_url?: string;
    rollout_database_ref?: string;
  };

  const createSnapshot = !body.snapshot_id;
  if (createSnapshot) {
    const required = [
      body.gate_name,
      body.gate_version,
      body.candidate_kind,
      body.candidate_id,
      body.candidate_version,
      body.semantic_facade_version,
    ];
    if (required.some((value) => !value)) {
      reply.code(400);
      return { error: "invalid_snapshot_request" };
    }
  }

  if (
    body.create_rollout_clone &&
    (!process.env.RELEASE_GATE_ROLLOUT_CLONE_COMMAND || !process.env.RELEASE_GATE_ROLLOUT_TEMPLATE_DATABASE)
  ) {
    reply.code(422);
    return { error: "release_gate_rollout_clone_not_configured" };
  }

  const rolloutCount = Math.max(1, Math.min(20, Number(body.rollout_count ?? 1)));
  const gateRunId = randomUUID();
  const snapshotId = body.snapshot_id ?? randomUUID();
  const sourceDatabaseUrl = body.source_database_url ?? getDatabaseUrl();
  const client = await pool.connect();
  let snapshot: SnapshotRow;
  const createdRollouts: RolloutRow[] = [];

  try {
    await client.query("BEGIN");

    if (createSnapshot) {
      const snapshotResult = await client.query<SnapshotRow>(
        `
          INSERT INTO release_gate_snapshots (
            id,
            snapshot_key,
            gate_name,
            gate_version,
            candidate_kind,
            candidate_id,
            candidate_version,
            projection_runtime,
            semantic_facade_version,
            manifest,
            criteria,
            source_refs,
            created_by_agent_id,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, NOW())
          RETURNING *
        `,
        [
          snapshotId,
          body.snapshot_key ?? `snapshot:${gateRunId}`,
          body.gate_name,
          body.gate_version,
          body.candidate_kind,
          body.candidate_id,
          body.candidate_version,
          body.projection_runtime ?? "postgres-template",
          body.semantic_facade_version,
          JSON.stringify(isJsonObject(body.manifest) ? body.manifest : {}),
          JSON.stringify(isJsonObject(body.criteria) ? body.criteria : {}),
          JSON.stringify(Array.isArray(body.source_refs) ? body.source_refs : []),
          body.created_by_agent_id ?? null,
        ],
      );
      snapshot = snapshotResult.rows[0];
    } else {
      const existingSnapshot = await getSnapshot(client, snapshotId);
      if (!existingSnapshot) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: "snapshot_not_found" };
      }
      snapshot = existingSnapshot;
    }

    const runResult = await client.query<GateRunRow>(
      `
        INSERT INTO release_gate_runs (
          id,
          run_key,
          snapshot_id,
          projection_run_id,
          status,
          decision,
          gate_manifest,
          projection_result,
          decision_result,
          failure_reason,
          started_at,
          completed_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'created', 'not_run', $5::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, NOW(), NULL, NOW(), NOW())
        RETURNING *
      `,
      [
        gateRunId,
        body.run_key ?? `run:${gateRunId}`,
        snapshot.id,
        body.projection_run_id ?? null,
        JSON.stringify(isJsonObject(body.gate_manifest) ? body.gate_manifest : {}),
      ],
    );

    await insertSemanticEvent(client, {
      gateRunId,
      semanticFacadeVersion: snapshot.semantic_facade_version,
      eventType: "release_gate_run.created",
      aggregateType: "release_gate_run",
      aggregateId: gateRunId,
      payload: { snapshot_id: snapshot.id, rollout_count: rolloutCount },
    });

    for (let index = 0; index < rolloutCount; index += 1) {
      const rolloutId = randomUUID();
      const rolloutOrdinal = index + 1;
      const seed = body.rollout_seeds?.[index] ?? rolloutOrdinal;
      const databaseName = buildRolloutDatabaseName(gateRunId, rolloutOrdinal);
      const databaseRef = body.create_rollout_clone
        ? buildRolloutDatabaseUrl(sourceDatabaseUrl, databaseName)
        : body.rollout_database_ref ?? `projection://inline/${gateRunId}/${rolloutOrdinal}`;
      const rolloutManifest = {
        ...(isJsonObject(body.rollout_manifest) ? body.rollout_manifest : {}),
        database_name: databaseName,
        source_database_url: body.create_rollout_clone ? sourceDatabaseUrl : undefined,
        clone_template: process.env.RELEASE_GATE_ROLLOUT_TEMPLATE_DATABASE,
      };

      const rolloutResult = await client.query<RolloutRow>(
        `
          INSERT INTO release_gate_rollouts (
            id,
            rollout_key,
            gate_run_id,
            snapshot_id,
            status,
            rollout_ordinal,
            seed,
            database_ref,
            object_store_prefix,
            fault_manifest,
            rollout_manifest,
            started_at,
            completed_at,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
            NULL, NULL, NOW(), NOW()
          )
          RETURNING *
        `,
        [
          rolloutId,
          `${gateRunId}:${rolloutOrdinal}`,
          gateRunId,
          snapshot.id,
          body.create_rollout_clone ? "requested" : "created",
          rolloutOrdinal,
          seed,
          databaseRef,
          body.object_store_prefix ? `${body.object_store_prefix.replace(/\/+$/, "")}/${rolloutId}` : null,
          JSON.stringify(isJsonObject(body.fault_manifest) ? body.fault_manifest : {}),
          JSON.stringify(rolloutManifest),
        ],
      );
      createdRollouts.push(rolloutResult.rows[0]);
    }

    await client.query("COMMIT");

    if (body.create_rollout_clone) {
      for (const rollout of createdRollouts) {
        const databaseName = buildRolloutDatabaseName(gateRunId, Number(rollout.rollout_ordinal));
        try {
          const cloneResult = await cloneRolloutDatabase({
            gateRunId,
            rolloutId: rollout.id,
            sourceDatabaseUrl,
            rolloutDatabaseName: databaseName,
          });
          await pool.query(
            `
              UPDATE release_gate_rollouts
              SET status = 'cloned',
                  rollout_manifest = rollout_manifest || $2::jsonb,
                  started_at = COALESCE(started_at, NOW()),
                  completed_at = NOW(),
                  updated_at = NOW()
              WHERE id = $1
            `,
            [rollout.id, JSON.stringify({ clone_stdout: cloneResult.stdout, clone_stderr: cloneResult.stderr })],
          );
          await insertSemanticEvent(pool, {
            gateRunId,
            rolloutId: rollout.id,
            semanticFacadeVersion: snapshot.semantic_facade_version,
            eventType: "release_gate_rollout.cloned",
            aggregateType: "release_gate_rollout",
            aggregateId: rollout.id,
            payload: cloneResult,
          });
        } catch (error) {
          await pool.query(
            `
              UPDATE release_gate_rollouts
              SET status = 'failed',
                  rollout_manifest = rollout_manifest || $2::jsonb,
                  started_at = COALESCE(started_at, NOW()),
                  completed_at = NOW(),
                  updated_at = NOW()
              WHERE id = $1
            `,
            [rollout.id, JSON.stringify({ clone_error: String(error) })],
          );
          await insertSemanticEvent(pool, {
            gateRunId,
            rolloutId: rollout.id,
            semanticFacadeVersion: snapshot.semantic_facade_version,
            eventType: "release_gate_rollout.failed",
            aggregateType: "release_gate_rollout",
            aggregateId: rollout.id,
            payload: { error: String(error) },
          });
        }
      }
    }

    reply.code(201);
    return {
      ...mapGateRun(runResult.rows[0]),
      snapshot: mapSnapshot(snapshot),
      rollouts: createdRollouts.map(mapRollout),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/internal/release-gate/runs/:runId", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const details = await getGateRunDetails(pool, runId);
  if (!details) {
    reply.code(404);
    return { error: "gate_run_not_found" };
  }
  return details;
});

async function completeGateRun(request: FastifyRequest, reply: FastifyReply) {
  const { runId } = request.params as { runId: string };
  const body = (request.body ?? {}) as {
    issue_promotion_artifact?: boolean;
    approved_scopes?: unknown;
    promotion_risk_limits?: unknown;
    promotion_expires_at?: string;
    artifact_kind?: string;
    rollout_plan?: unknown;
    manifest?: unknown;
  };

  const shouldIssueArtifact = body.issue_promotion_artifact !== false;
  const approvedScopes = parseStringArray(body.approved_scopes);
  if (shouldIssueArtifact && approvedScopes.length === 0) {
    reply.code(400);
    return { error: "approved_scopes_required" };
  }
  if (shouldIssueArtifact && !isJsonObject(body.promotion_risk_limits)) {
    reply.code(400);
    return { error: "promotion_risk_limits_required" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const joined = await getGateRunWithSnapshot(client, runId);
    if (!joined) {
      await client.query("ROLLBACK");
      reply.code(404);
      return { error: "gate_run_not_found" };
    }

    await client.query(
      "UPDATE release_gate_runs SET status = 'running', updated_at = NOW() WHERE id = $1",
      [runId],
    );
    await insertSemanticEvent(client, {
      gateRunId: runId,
      semanticFacadeVersion: joined.snapshot.semantic_facade_version,
      eventType: "release_gate_run.verifier_started",
      aggregateType: "release_gate_run",
      aggregateId: runId,
      payload: {},
    });

    const verifierResult = await runDeterministicVerifier(client, joined.gateRun, joined.snapshot);
    await persistVerifierChecks(client, runId, verifierResult);
    const finalStatus: GateRunStatus = verifierResult.status === "passed" ? "passed" : "failed";

    await client.query(
      `
        UPDATE release_gate_runs
        SET status = $2,
            decision = $3,
            decision_result = $4::jsonb,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [runId, finalStatus, verifierResult.status, JSON.stringify(verifierResult)],
    );

    for (const check of verifierResult.checks) {
      await insertSemanticEvent(client, {
        gateRunId: runId,
        semanticFacadeVersion: joined.snapshot.semantic_facade_version,
        eventType: "release_gate_run.verifier_check",
        aggregateType: "release_gate_verifier_check",
        aggregateId: check.key,
        payload: check,
      });
    }

    let promotionArtifact = null;
    if (verifierResult.status === "passed" && shouldIssueArtifact) {
      promotionArtifact = await createPromotionArtifact(client, {
        gateRun: joined.gateRun,
        snapshot: joined.snapshot,
        verifierResult,
        approvedScopes,
        riskLimits: body.promotion_risk_limits as JsonObject,
        expiresAt: body.promotion_expires_at,
        artifactKind: body.artifact_kind,
        rolloutPlan: isJsonObject(body.rollout_plan) ? body.rollout_plan : {},
        manifest: isJsonObject(body.manifest) ? body.manifest : {},
      });
      await insertSemanticEvent(client, {
        gateRunId: runId,
        semanticFacadeVersion: joined.snapshot.semantic_facade_version,
        eventType: "release_gate_promotion_artifact.issued",
        aggregateType: "release_gate_promotion_artifact",
        aggregateId: promotionArtifact.id,
        payload: {
          approved_scopes: promotionArtifact.approved_scopes,
          risk_limits: promotionArtifact.risk_limits,
        },
      });
    }

    await insertSemanticEvent(client, {
      gateRunId: runId,
      semanticFacadeVersion: joined.snapshot.semantic_facade_version,
      eventType: "release_gate_run.completed",
      aggregateType: "release_gate_run",
      aggregateId: runId,
      payload: {
        status: finalStatus,
        decision: verifierResult.status,
        promotion_artifact_issued: promotionArtifact !== null,
      },
    });

    await client.query("COMMIT");
    return {
      gate_run_id: runId,
      status: finalStatus,
      decision: verifierResult.status,
      verifier_result: verifierResult,
      promotion_artifact: promotionArtifact,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

app.post("/v1/internal/release-gate/runs/:runId/complete", completeGateRun);
app.post("/v1/internal/release-gate/runs/:runId/verify", completeGateRun);

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
