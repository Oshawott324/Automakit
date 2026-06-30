import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { createDatabasePool, ensureCoreSchema, toIsoTimestamp } from "@automakit/persistence";

type AgentContext = {
  id: string;
  public_key: string;
  status: "pending_verification" | "active" | "suspended" | "disabled";
};

type IntrospectionResponse = {
  active: boolean;
  agent?: AgentContext;
  expires_at?: string;
};

type OrderStatus = "open" | "partially_filled" | "filled" | "canceled";
type Side = "buy" | "sell";
type Outcome = "YES" | "NO";

type OrderRow = {
  id: string;
  agent_id: string;
  market_id: string;
  client_order_id: string;
  idempotency_key: string;
  side: Side;
  outcome: Outcome;
  price: unknown;
  size: unknown;
  filled_size: unknown;
  status: OrderStatus;
  signed_at: unknown;
  request_signature: string;
  created_at: unknown;
  updated_at: unknown;
  canceled_at: unknown;
};

type FillRow = {
  id: string;
  market_id: string;
  outcome: Outcome;
  price: unknown;
  size: unknown;
  buy_order_id: string;
  sell_order_id: string;
  buy_agent_id: string;
  sell_agent_id: string;
  executed_at: unknown;
};

type PromotionArtifactRow = {
  id: string;
  artifact_key: string;
  candidate_id: string;
  status: string;
  approved_scopes: unknown;
  risk_limits: unknown;
  manifest: unknown;
  expires_at: unknown;
};

type OrderbookLevel = {
  price: number;
  size: number;
};

type OrderbookRow = {
  outcome: Outcome;
  side: Side;
  price: unknown;
  remaining_size: unknown;
};

type PortfolioPositionRow = {
  market_id: string;
  outcome: Outcome;
  quantity: unknown;
  reserved_quantity: unknown;
  cost_basis_notional: unknown;
  mark_price_yes: unknown;
  final_outcome: unknown;
};

type PortfolioSnapshot = {
  agent_id: string;
  cash_balance: number;
  reserved_balance: number;
  realized_pnl: number;
  unrealized_pnl: number;
  fees: number;
  payouts: number;
  positions: Array<{
    market_id: string;
    outcome: Outcome;
    quantity: number;
    reserved_quantity: number;
    average_price: number;
    mark_price: number;
    unrealized_pnl: number;
  }>;
};

type MatchingFill = {
  fill_id: string;
  market_id: string;
  outcome: Outcome;
  price: number;
  size: number;
  buy_order_id: string;
  sell_order_id: string;
  buy_agent_id: string;
  sell_agent_id: string;
  executed_at: string;
};

type MatchingOrderUpdate = {
  order_id: string;
  filled_size: number;
  remaining_size: number;
  status: OrderStatus;
};

type MatchingSubmitResponse = {
  order_id: string;
  status: OrderStatus;
  filled_size: number;
  remaining_size: number;
  fills: MatchingFill[];
  touched_orders: MatchingOrderUpdate[];
};

type ExecutionMode = "projection" | "shadow_live" | "tiny_notional_live" | "limited_live";
type ExecutionBackendName = "ProjectionBackend" | "LiveBackend";

type ExecutionLabels = {
  execution_mode: ExecutionMode;
  execution_backend: ExecutionBackendName;
};

type BackendResponse<T extends object = Record<string, unknown>> = {
  statusCode: number;
  body: T;
};

type SubmitOrderRequest = {
  market_id?: string;
  side?: Side;
  outcome?: Outcome;
  price?: number;
  size?: number;
  client_order_id?: string;
  execution_mode?: unknown;
  promotion_artifact_id?: unknown;
};

type CancelOrderRequest = {
  order_id?: string;
  client_order_id?: string;
  market_id?: string;
  side?: Side;
  outcome?: Outcome;
  execution_mode?: unknown;
  promotion_artifact_id?: unknown;
};

type SubmitOrderInput = {
  agent: AgentContext;
  body: SubmitOrderRequest;
  idempotencyKey: string;
  signedTimestamp: string;
  requestSignature: string;
};

type CancelOrderInput = {
  agent: AgentContext;
  body: CancelOrderRequest;
};

type GetOrderInput = {
  agent: AgentContext;
  orderId: string;
};

type ExecutionBackend = {
  mode: ExecutionMode;
  backend: ExecutionBackendName;
  labels: ExecutionLabels;
  getPortfolio(agent: AgentContext): Promise<BackendResponse>;
  submitOrder(input: SubmitOrderInput): Promise<BackendResponse>;
  cancelOrder(input: CancelOrderInput): Promise<BackendResponse>;
  getOrder(input: GetOrderInput): Promise<BackendResponse>;
  listFills(agent: AgentContext): Promise<BackendResponse>;
};

type GateToolName =
  | "portfolio.get"
  | "orders.submit"
  | "orders.cancel"
  | "orders.get"
  | "fills.list";

type LiveWriteToolName = "orders.submit" | "orders.cancel";

type JsonObject = Record<string, unknown>;

type PromotionDenial = {
  statusCode: 400 | 403;
  body: {
    error: string;
    message: string;
    promotion_artifact_id?: string;
    tool_name: LiveWriteToolName;
    execution_mode: Exclude<ExecutionMode, "projection">;
    details?: JsonObject;
  };
};

type PromotionAuthorization =
  | {
      ok: true;
      artifact: PromotionArtifactRow;
    }
  | ({
      ok: false;
    } & PromotionDenial);

type LiveWriteRiskContext = {
  marketId?: string;
  side?: Side;
  outcome?: Outcome;
  notional?: number;
};

type GateRecordingFailure = {
  code: string;
  message: string;
  stage: "state_hash" | "ledger_insert";
};

type GateStateCapture = {
  hash: string | null;
  failures: GateRecordingFailure[];
};

declare module "fastify" {
  interface FastifyRequest {
    agentContext?: AgentContext;
  }
}

const port = Number(process.env.AGENT_GATEWAY_PORT ?? 4001);
const authRegistryUrl = process.env.AUTH_REGISTRY_URL ?? "http://localhost:4002";
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";
const portfolioServiceUrl = process.env.PORTFOLIO_SERVICE_URL ?? "http://localhost:4004";
const matchingEngineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:7400";
const maxSignatureAgeMs = Number(process.env.AGENT_REQUEST_MAX_AGE_MS ?? 5 * 60_000);
const gateRunId = process.env.GATE_RUN_ID;
const gateRolloutId = process.env.GATE_ROLLOUT_ID;
const gateToolNamespace = "agent_gateway.execution";
const semanticFacadeVersion = "projection-execution-facade@1";
const app = Fastify({ logger: true });
const pool = createDatabasePool();

type Queryable = Pick<PoolClient, "query">;

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

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

const executionModes = new Set<ExecutionMode>([
  "projection",
  "shadow_live",
  "tiny_notional_live",
  "limited_live",
]);

function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && executionModes.has(value as ExecutionMode);
}

function executionLabels(mode: ExecutionMode): ExecutionLabels {
  return {
    execution_mode: mode,
    execution_backend: mode === "projection" ? "ProjectionBackend" : "LiveBackend",
  };
}

function withExecutionLabels<T extends object>(body: T, labels: ExecutionLabels): T & ExecutionLabels {
  return {
    ...body,
    ...labels,
  };
}

function liveExecutionDisabledBody(labels: ExecutionLabels) {
  return withExecutionLabels(
    {
      error: "live_execution_disabled",
      message: "Live execution is disabled in this build. Use projection mode until promotion enforcement and live adapters are enabled.",
    },
    labels,
  );
}

function resolveExecutionMode(request: FastifyRequest): { ok: true; mode: ExecutionMode } | { ok: false; value: unknown } {
  const headerMode = request.headers["x-execution-mode"];
  const bodyMode = typeof request.body === "object" && request.body !== null
    ? (request.body as { execution_mode?: unknown }).execution_mode
    : undefined;
  const requestedMode = bodyMode ?? (typeof headerMode === "string" ? headerMode : undefined) ?? "projection";

  if (!isExecutionMode(requestedMode)) {
    return { ok: false, value: requestedMode };
  }

  return { ok: true, mode: requestedMode };
}

function isLiveExecutionMode(mode: ExecutionMode): mode is Exclude<ExecutionMode, "projection"> {
  return mode !== "projection";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): { ok: true; values: string[] } | { ok: false } {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { ok: false };
  }
  return { ok: true, values: value };
}

function sideFromUnknown(value: unknown): Side | undefined {
  return value === "buy" || value === "sell" ? value : undefined;
}

function outcomeFromUnknown(value: unknown): Outcome | undefined {
  return value === "YES" || value === "NO" ? value : undefined;
}

function promotionDenial(input: {
  statusCode?: 400 | 403;
  error: string;
  message: string;
  artifactId?: string;
  toolName: LiveWriteToolName;
  mode: Exclude<ExecutionMode, "projection">;
  details?: JsonObject;
}): PromotionAuthorization {
  return {
    ok: false,
    statusCode: input.statusCode ?? 403,
    body: {
      error: input.error,
      message: input.message,
      ...(input.artifactId ? { promotion_artifact_id: input.artifactId } : {}),
      tool_name: input.toolName,
      execution_mode: input.mode,
      ...(input.details ? { details: input.details } : {}),
    },
  };
}

function requestedPromotionArtifactId(
  request: FastifyRequest,
  body: { promotion_artifact_id?: unknown },
): { ok: true; artifactId: string } | { ok: false; statusCode: 400 | 403; error: string; message: string } {
  const headerValue = request.headers["x-promotion-artifact-id"];
  if (Array.isArray(headerValue)) {
    return {
      ok: false,
      statusCode: 400,
      error: "promotion_artifact_header_invalid",
      message: "Use one x-promotion-artifact-id header value for live write requests.",
    };
  }
  if (typeof headerValue === "string") {
    const artifactId = headerValue.trim();
    if (artifactId.length === 0) {
      return {
        ok: false,
        statusCode: 400,
        error: "promotion_artifact_id_invalid",
        message: "Promotion artifact id must be a non-empty string.",
      };
    }
    return { ok: true, artifactId };
  }

  if (body.promotion_artifact_id !== undefined) {
    if (typeof body.promotion_artifact_id !== "string" || body.promotion_artifact_id.trim().length === 0) {
      return {
        ok: false,
        statusCode: 400,
        error: "promotion_artifact_id_invalid",
        message: "Body field promotion_artifact_id must be a non-empty string.",
      };
    }
    return { ok: true, artifactId: body.promotion_artifact_id.trim() };
  }

  return {
    ok: false,
    statusCode: 403,
    error: "promotion_artifact_required",
    message: "Live write requests require x-promotion-artifact-id or body promotion_artifact_id.",
  };
}

function scopeMatches(approvedScopes: string[], requiredScope: string) {
  if (approvedScopes.includes("*") || approvedScopes.includes(requiredScope)) {
    return true;
  }

  const separatorIndex = requiredScope.includes(":")
    ? requiredScope.indexOf(":")
    : requiredScope.indexOf(".");
  if (separatorIndex < 0) {
    return false;
  }

  return approvedScopes.includes(`${requiredScope.slice(0, separatorIndex)}:*`);
}

function optionalStringArrayLimit(
  riskLimits: JsonObject,
  field: string,
): { ok: true; values?: string[] } | { ok: false; error: string; message: string } {
  if (!(field in riskLimits)) {
    return { ok: true };
  }

  const parsed = parseStringArray(riskLimits[field]);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "promotion_artifact_risk_limits_invalid",
      message: `Risk limit ${field} must be an array of strings.`,
    };
  }

  return { ok: true, values: parsed.values };
}

function validateAllowedStringLimit(input: {
  riskLimits: JsonObject;
  field: string;
  actual: string | undefined;
  missingCode: string;
  deniedCode: string;
  label: string;
}): { ok: true } | { ok: false; error: string; message: string; details: JsonObject } {
  const parsed = optionalStringArrayLimit(input.riskLimits, input.field);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, message: parsed.message, details: { field: input.field } };
  }
  if (parsed.values === undefined) {
    return { ok: true };
  }
  if (input.actual === undefined) {
    return {
      ok: false,
      error: input.missingCode,
      message: `Risk limit ${input.field} requires ${input.label} in the live write request or resolvable order context.`,
      details: {
        field: input.field,
        allowed_values: parsed.values,
      },
    };
  }
  if (!parsed.values.includes(input.actual)) {
    return {
      ok: false,
      error: input.deniedCode,
      message: `${input.label} is outside the promotion artifact risk limits.`,
      details: {
        field: input.field,
        requested_value: input.actual,
        allowed_values: parsed.values,
      },
    };
  }

  return { ok: true };
}

function validateRiskLimits(input: {
  riskLimits: JsonObject;
  mode: Exclude<ExecutionMode, "projection">;
  toolName: LiveWriteToolName;
  context: LiveWriteRiskContext;
}): { ok: true } | { ok: false; error: string; message: string; details: JsonObject } {
  const executionModeCheck = validateAllowedStringLimit({
    riskLimits: input.riskLimits,
    field: "allowed_execution_modes",
    actual: input.mode,
    missingCode: "promotion_artifact_execution_mode_context_missing",
    deniedCode: "promotion_artifact_execution_mode_denied",
    label: "execution mode",
  });
  if (!executionModeCheck.ok) {
    return executionModeCheck;
  }

  for (const check of [
    validateAllowedStringLimit({
      riskLimits: input.riskLimits,
      field: "allowed_market_ids",
      actual: input.context.marketId,
      missingCode: "promotion_artifact_market_context_missing",
      deniedCode: "promotion_artifact_market_denied",
      label: "market id",
    }),
    validateAllowedStringLimit({
      riskLimits: input.riskLimits,
      field: "allowed_sides",
      actual: input.context.side,
      missingCode: "promotion_artifact_side_context_missing",
      deniedCode: "promotion_artifact_side_denied",
      label: "side",
    }),
    validateAllowedStringLimit({
      riskLimits: input.riskLimits,
      field: "allowed_outcomes",
      actual: input.context.outcome,
      missingCode: "promotion_artifact_outcome_context_missing",
      deniedCode: "promotion_artifact_outcome_denied",
      label: "outcome",
    }),
  ]) {
    if (!check.ok) {
      return check;
    }
  }

  if ("max_order_notional" in input.riskLimits && input.toolName === "orders.submit") {
    const limit = input.riskLimits.max_order_notional;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      return {
        ok: false,
        error: "promotion_artifact_risk_limits_invalid",
        message: "Risk limit max_order_notional must be a non-negative number.",
        details: { field: "max_order_notional" },
      };
    }
    if (input.context.notional === undefined || !Number.isFinite(input.context.notional)) {
      return {
        ok: false,
        error: "promotion_artifact_notional_context_missing",
        message: "Risk limit max_order_notional requires numeric price and size in the live write request.",
        details: { field: "max_order_notional", max_order_notional: limit },
      };
    }
    if (input.context.notional > limit) {
      return {
        ok: false,
        error: "promotion_artifact_notional_exceeded",
        message: "Order notional exceeds the promotion artifact risk limit.",
        details: {
          requested_notional: input.context.notional,
          max_order_notional: limit,
        },
      };
    }
  }

  return { ok: true };
}

async function resolveCancelRiskContext(
  agent: AgentContext,
  body: CancelOrderRequest,
): Promise<LiveWriteRiskContext> {
  const context: LiveWriteRiskContext = {
    marketId: typeof body.market_id === "string" ? body.market_id : undefined,
    side: sideFromUnknown(body.side),
    outcome: outcomeFromUnknown(body.outcome),
  };

  if ((context.marketId && context.side && context.outcome) || (!body.order_id && !body.client_order_id)) {
    return context;
  }

  const result = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE agent_id = $1
        AND (id = $2 OR client_order_id = $3)
      LIMIT 1
    `,
    [agent.id, body.order_id ?? null, body.client_order_id ?? null],
  );
  const order = result.rows[0];
  if (!order) {
    return context;
  }

  return {
    marketId: context.marketId ?? order.market_id,
    side: context.side ?? order.side,
    outcome: context.outcome ?? order.outcome,
  };
}

async function authorizeLiveWrite(input: {
  request: FastifyRequest;
  agent: AgentContext;
  body: SubmitOrderRequest | CancelOrderRequest;
  mode: Exclude<ExecutionMode, "projection">;
  toolName: LiveWriteToolName;
  riskContext: LiveWriteRiskContext;
}): Promise<PromotionAuthorization> {
  const artifactInput = requestedPromotionArtifactId(input.request, input.body);
  if (!artifactInput.ok) {
    return promotionDenial({
      statusCode: artifactInput.statusCode,
      error: artifactInput.error,
      message: artifactInput.message,
      toolName: input.toolName,
      mode: input.mode,
    });
  }

  const result = await pool.query<PromotionArtifactRow>(
    `
      SELECT
        id,
        artifact_key,
        candidate_id,
        status,
        approved_scopes,
        risk_limits,
        manifest,
        expires_at
      FROM release_gate_promotion_artifacts
      WHERE id = $1 OR artifact_key = $1
      LIMIT 1
    `,
    [artifactInput.artifactId],
  );
  const artifact = result.rows[0];
  if (!artifact) {
    return promotionDenial({
      error: "promotion_artifact_not_found",
      message: "Promotion artifact was not found.",
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
    });
  }

  if (artifact.status === "revoked") {
    return promotionDenial({
      error: "promotion_artifact_revoked",
      message: "Promotion artifact has been revoked.",
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
      details: { artifact_status: artifact.status },
    });
  }
  if (artifact.status !== "issued") {
    return promotionDenial({
      error: "promotion_artifact_not_issued",
      message: "Promotion artifact is not in issued status.",
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
      details: { artifact_status: artifact.status },
    });
  }

  if (artifact.expires_at !== null) {
    const expiresAt = new Date(String(artifact.expires_at)).getTime();
    if (!Number.isFinite(expiresAt)) {
      return promotionDenial({
        error: "promotion_artifact_expiry_invalid",
        message: "Promotion artifact expiry is not a valid timestamp.",
        artifactId: artifactInput.artifactId,
        toolName: input.toolName,
        mode: input.mode,
      });
    }
    if (expiresAt <= Date.now()) {
      return promotionDenial({
        error: "promotion_artifact_expired",
        message: "Promotion artifact has expired.",
        artifactId: artifactInput.artifactId,
        toolName: input.toolName,
        mode: input.mode,
        details: { expires_at: toIsoTimestamp(artifact.expires_at) },
      });
    }
  }

  const manifest = isJsonObject(artifact.manifest) ? artifact.manifest : {};
  const manifestAgentId = typeof manifest.agent_id === "string" ? manifest.agent_id : undefined;
  if (artifact.candidate_id !== input.agent.id && manifestAgentId !== input.agent.id) {
    return promotionDenial({
      error: "promotion_artifact_agent_mismatch",
      message: "Promotion artifact does not belong to this agent.",
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
      details: {
        artifact_candidate_id: artifact.candidate_id,
        manifest_agent_id: manifestAgentId ?? null,
      },
    });
  }

  const scopes = parseStringArray(artifact.approved_scopes);
  if (!scopes.ok) {
    return promotionDenial({
      error: "promotion_artifact_scopes_invalid",
      message: "Promotion artifact approved_scopes must be an array of strings.",
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
    });
  }
  const requiredExecutionScope = `execution:${input.mode}`;
  if (!scopeMatches(scopes.values, requiredExecutionScope) || !scopeMatches(scopes.values, input.toolName)) {
    return promotionDenial({
      error: "promotion_artifact_scope_denied",
      message: "Promotion artifact does not approve the requested execution mode and tool.",
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
      details: {
        approved_scopes: scopes.values,
        required_scopes: [requiredExecutionScope, input.toolName],
      },
    });
  }

  if (!isJsonObject(artifact.risk_limits)) {
    return promotionDenial({
      error: "promotion_artifact_risk_limits_invalid",
      message: "Promotion artifact risk_limits must be a JSON object.",
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
    });
  }
  const riskCheck = validateRiskLimits({
    riskLimits: artifact.risk_limits,
    mode: input.mode,
    toolName: input.toolName,
    context: input.riskContext,
  });
  if (!riskCheck.ok) {
    return promotionDenial({
      error: riskCheck.error,
      message: riskCheck.message,
      artifactId: artifactInput.artifactId,
      toolName: input.toolName,
      mode: input.mode,
      details: riskCheck.details,
    });
  }

  return { ok: true, artifact };
}

async function recordDeniedLiveWrite(input: {
  agent: AgentContext;
  mode: Exclude<ExecutionMode, "projection">;
  toolName: LiveWriteToolName;
  body: unknown;
  riskContext: LiveWriteRiskContext;
  denial: PromotionDenial["body"];
  statusCode: number;
}) {
  await appendStreamEvent(pool, {
    channel: "release_gate.live_write_denied",
    market_id: input.riskContext.marketId ?? null,
    agent_id: input.agent.id,
    payload: {
      agent_id: input.agent.id,
      tool_name: input.toolName,
      execution_mode: input.mode,
      execution_backend: "LiveBackend",
      status_code: input.statusCode,
      denial: input.denial,
      risk_context: input.riskContext,
      request_body: input.body,
    },
  });
}

function buildSignedPayload(method: string, path: string, agentId: string, timestamp: string, body: unknown) {
  return [method.toUpperCase(), path, agentId, timestamp, sha256(stableStringify(body ?? {}))].join("\n");
}

function verifyDetachedSignature(publicKeyPem: string, payload: string, signature: string) {
  try {
    const key = createPublicKey(publicKeyPem);
    return verifySignature(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

function mapOrderRow(row: OrderRow) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    market_id: row.market_id,
    client_order_id: row.client_order_id,
    side: row.side,
    outcome: row.outcome,
    price: Number(row.price),
    size: Number(row.size),
    filled_size: Number(row.filled_size),
    status: row.status,
    signed_at: toIsoTimestamp(row.signed_at),
    request_signature: row.request_signature,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    canceled_at: row.canceled_at ? toIsoTimestamp(row.canceled_at) : null,
  };
}

function mapFillRow(row: FillRow) {
  return {
    id: row.id,
    market_id: row.market_id,
    outcome: row.outcome,
    price: Number(row.price),
    size: Number(row.size),
    buy_order_id: row.buy_order_id,
    sell_order_id: row.sell_order_id,
    buy_agent_id: row.buy_agent_id,
    sell_agent_id: row.sell_agent_id,
    executed_at: toIsoTimestamp(row.executed_at),
  };
}

async function getOrderbookSnapshot(client: Queryable, marketId: string) {
  const result = await client.query<OrderbookRow>(
    `
      SELECT
        outcome,
        side,
        price,
        SUM(GREATEST(size - filled_size, 0)) AS remaining_size
      FROM orders
      WHERE market_id = $1
        AND status IN ('open', 'partially_filled')
      GROUP BY outcome, side, price
    `,
    [marketId],
  );

  const snapshot = {
    market_id: marketId,
    yes_bids: [] as OrderbookLevel[],
    yes_asks: [] as OrderbookLevel[],
    no_bids: [] as OrderbookLevel[],
    no_asks: [] as OrderbookLevel[],
  };

  for (const row of result.rows) {
    const level = {
      price: Number(row.price),
      size: Number(row.remaining_size),
    };

    if (row.outcome === "YES" && row.side === "buy") {
      snapshot.yes_bids.push(level);
    } else if (row.outcome === "YES" && row.side === "sell") {
      snapshot.yes_asks.push(level);
    } else if (row.outcome === "NO" && row.side === "buy") {
      snapshot.no_bids.push(level);
    } else if (row.outcome === "NO" && row.side === "sell") {
      snapshot.no_asks.push(level);
    }
  }

  snapshot.yes_bids.sort((left, right) => right.price - left.price || right.size - left.size);
  snapshot.yes_asks.sort((left, right) => left.price - right.price || right.size - left.size);
  snapshot.no_bids.sort((left, right) => right.price - left.price || right.size - left.size);
  snapshot.no_asks.sort((left, right) => left.price - right.price || right.size - left.size);

  return snapshot;
}

async function getPortfolioSnapshot(client: Queryable, agentId: string): Promise<PortfolioSnapshot> {
  const [accountResult, positionsResult] = await Promise.all([
    client.query<{
      cash_balance: unknown;
      reserved_cash: unknown;
      realized_pnl: unknown;
      fees: unknown;
      payouts: unknown;
    }>(
      `
        SELECT cash_balance, reserved_cash, realized_pnl, fees, payouts
        FROM portfolio_accounts
        WHERE agent_id = $1
      `,
      [agentId],
    ),
    client.query<PortfolioPositionRow>(
      `
        SELECT
          p.market_id,
          p.outcome,
          p.quantity,
          p.reserved_quantity,
          p.cost_basis_notional,
          m.last_traded_price_yes AS mark_price_yes,
          rc.final_outcome
        FROM portfolio_positions p
        JOIN markets m ON m.id = p.market_id
        LEFT JOIN resolution_cases rc ON rc.market_id = p.market_id
        WHERE p.agent_id = $1
          AND p.quantity > 0
      `,
      [agentId],
    ),
  ]);

  const account = accountResult.rows[0];
  let unrealizedPnl = 0;
  const positions = positionsResult.rows.map((row) => {
    const quantity = Number(row.quantity);
    const costBasis = Number(row.cost_basis_notional);
    const averagePrice = quantity > 0 ? costBasis / quantity : 0;
    let markPriceYes = Number(row.mark_price_yes ?? 0);
    if (row.final_outcome === "YES") {
      markPriceYes = 1;
    } else if (row.final_outcome === "NO") {
      markPriceYes = 0;
    }
    const markPrice = row.outcome === "YES" ? markPriceYes : 1 - markPriceYes;
    const unrealized = quantity * (markPrice - averagePrice);
    unrealizedPnl += unrealized;

    return {
      market_id: row.market_id,
      outcome: row.outcome,
      quantity,
      reserved_quantity: Number(row.reserved_quantity),
      average_price: averagePrice,
      mark_price: markPrice,
      unrealized_pnl: unrealized,
    };
  });

  return {
    agent_id: agentId,
    cash_balance: Number(account?.cash_balance ?? 0),
    reserved_balance: Number(account?.reserved_cash ?? 0),
    realized_pnl: Number(account?.realized_pnl ?? 0),
    unrealized_pnl: unrealizedPnl,
    fees: Number(account?.fees ?? 0),
    payouts: Number(account?.payouts ?? 0),
    positions,
  };
}

async function appendStreamEvent(
  client: Queryable,
  event: {
    channel: string;
    market_id?: string | null;
    agent_id?: string | null;
    payload: unknown;
    created_at?: string;
  },
) {
  await client.query(
    `
      INSERT INTO stream_events (
        event_id,
        channel,
        market_id,
        agent_id,
        payload,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
    `,
    [
      randomUUID(),
      event.channel,
      event.market_id ?? null,
      event.agent_id ?? null,
      JSON.stringify(event.payload),
      event.created_at ?? new Date().toISOString(),
    ],
  );
}

function isGateRecordingEnabled() {
  return Boolean(gateRunId);
}

function gateFailure(stage: GateRecordingFailure["stage"], code: string, error: unknown): GateRecordingFailure {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    stage,
  };
}

function withGateRecordingFailures<T extends object>(
  body: T,
  failures: GateRecordingFailure[],
): T & { gate_recording?: { status: "failed"; errors: GateRecordingFailure[] } } {
  if (failures.length === 0) {
    return body;
  }

  return {
    ...body,
    gate_recording: {
      status: "failed",
      errors: failures,
    },
  };
}

async function jsonRows(
  client: Queryable,
  sql: string,
  params: Array<string | null>,
): Promise<unknown> {
  const result = await client.query<{ rows: unknown }>(sql, params);
  return result.rows[0]?.rows ?? [];
}

async function captureGateStateHash(
  client: Queryable,
  scope: {
    agentId: string;
    marketId?: string | null;
    orderId?: string | null;
  },
): Promise<GateStateCapture> {
  if (!isGateRecordingEnabled()) {
    return { hash: null, failures: [] };
  }

  const marketId = scope.marketId ?? null;
  const orderId = scope.orderId ?? null;

  try {
    const [accountRows, positionRows, orderRows, fillRows] = await Promise.all([
      jsonRows(
        client,
        `
          SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.agent_id), '[]'::jsonb) AS rows
          FROM (
            SELECT
              agent_id,
              cash_balance,
              reserved_cash,
              realized_pnl,
              unsettled_pnl,
              fees,
              payouts,
              updated_at
            FROM portfolio_accounts
            WHERE agent_id = $1
          ) row
        `,
        [scope.agentId],
      ),
      jsonRows(
        client,
        `
          SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.agent_id, row.market_id, row.outcome), '[]'::jsonb) AS rows
          FROM (
            SELECT
              agent_id,
              market_id,
              outcome,
              market_category,
              quantity,
              reserved_quantity,
              cost_basis_notional,
              updated_at
            FROM portfolio_positions
            WHERE agent_id = $1
              AND ($2::text IS NULL OR market_id = $2)
          ) row
        `,
        [scope.agentId, marketId],
      ),
      jsonRows(
        client,
        `
          SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.created_at, row.id), '[]'::jsonb) AS rows
          FROM (
            SELECT
              id,
              agent_id,
              market_id,
              client_order_id,
              side,
              outcome,
              price,
              size,
              filled_size,
              status,
              created_at,
              updated_at,
              canceled_at
            FROM orders
            WHERE agent_id = $1
              OR ($2::text IS NOT NULL AND market_id = $2)
              OR ($3::text IS NOT NULL AND id = $3)
          ) row
        `,
        [scope.agentId, marketId, orderId],
      ),
      jsonRows(
        client,
        `
          SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.executed_at, row.id), '[]'::jsonb) AS rows
          FROM (
            SELECT
              id,
              market_id,
              outcome,
              price,
              size,
              buy_order_id,
              sell_order_id,
              buy_agent_id,
              sell_agent_id,
              executed_at
            FROM fills
            WHERE buy_agent_id = $1
              OR sell_agent_id = $1
              OR ($2::text IS NOT NULL AND market_id = $2)
              OR ($3::text IS NOT NULL AND (buy_order_id = $3 OR sell_order_id = $3))
          ) row
        `,
        [scope.agentId, marketId, orderId],
      ),
    ]);

    return {
      hash: sha256(
        stableStringify({
          portfolio_accounts: accountRows,
          portfolio_positions: positionRows,
          orders: orderRows,
          fills: fillRows,
        }),
      ),
      failures: [],
    };
  } catch (error) {
    return {
      hash: null,
      failures: [gateFailure("state_hash", "gate_state_hash_failed", error)],
    };
  }
}

async function recordGateToolCall(call: {
  toolName: GateToolName;
  agentId: string;
  requestPayload: unknown;
  responsePayload: unknown;
  statusCode: number;
  preStateHash: string | null;
  postStateHash: string | null;
  observedFailures?: GateRecordingFailure[];
}): Promise<GateRecordingFailure[]> {
  if (!isGateRecordingEnabled()) {
    return [];
  }

  const gateErrors = call.observedFailures ?? [];
  const endpointFailed = call.statusCode >= 400;
  const errorResult = endpointFailed || gateErrors.length > 0
    ? {
        endpoint_error: endpointFailed ? call.responsePayload : null,
        recording_errors: gateErrors,
      }
    : null;

  try {
    await pool.query(
      `
        INSERT INTO release_gate_tool_calls (
          id,
          gate_run_id,
          rollout_id,
          call_key,
          agent_id,
          tool_namespace,
          tool_name,
          semantic_facade_version,
          request_manifest,
          response_result,
          error_result,
          state_before_hash,
          state_after_hash,
          evidence_refs,
          status,
          started_at,
          created_at,
          completed_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15, NOW(), NOW(), NOW()
        )
      `,
      [
        randomUUID(),
        gateRunId,
        gateRolloutId ?? null,
        randomUUID(),
        call.agentId,
        gateToolNamespace,
        call.toolName,
        semanticFacadeVersion,
        JSON.stringify(call.requestPayload),
        JSON.stringify({
          status_code: call.statusCode,
          body: call.responsePayload,
        }),
        errorResult === null ? null : JSON.stringify(errorResult),
        call.preStateHash,
        call.postStateHash,
        JSON.stringify([]),
        endpointFailed ? "failed" : "succeeded",
      ],
    );
    return [];
  } catch (error) {
    app.log.warn({ error }, "gate tool call recording failed");
    return [gateFailure("ledger_insert", "gate_tool_call_record_failed", error)];
  }
}

async function withGateToolCall<T extends object>(
  body: T,
  call: {
    toolName: GateToolName;
    agentId: string;
    requestPayload: unknown;
    statusCode: number;
    preState: GateStateCapture;
    postState?: GateStateCapture;
    postScope?: {
      agentId: string;
      marketId?: string | null;
      orderId?: string | null;
    };
  },
): Promise<T & { gate_recording?: { status: "failed"; errors: GateRecordingFailure[] } }> {
  const postState = call.postState ?? (
    call.postScope ? await captureGateStateHash(pool, call.postScope) : call.preState
  );
  const observedFailures = [...call.preState.failures, ...postState.failures];
  const insertFailures = await recordGateToolCall({
    toolName: call.toolName,
    agentId: call.agentId,
    requestPayload: call.requestPayload,
    responsePayload: body,
    statusCode: call.statusCode,
    preStateHash: call.preState.hash,
    postStateHash: postState.hash,
    observedFailures,
  });
  return withGateRecordingFailures(body, [...observedFailures, ...insertFailures]);
}

async function introspectToken(token: string): Promise<IntrospectionResponse> {
  const response = await fetch(`${authRegistryUrl}/v1/internal/tokens/introspect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    return { active: false };
  }

  return (await response.json()) as IntrospectionResponse;
}

async function ensureMarketExists(marketId: string) {
  const response = await fetch(`${marketServiceUrl}/v1/markets/${marketId}`);
  return response.ok;
}

async function submitToMatchingEngine(body: {
  order_id: string;
  agent_id: string;
  market_id: string;
  side: Side;
  outcome: Outcome;
  price: number;
  size: number;
  created_at: string;
}) {
  const response = await fetch(`${matchingEngineUrl}/v1/internal/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`matching_engine_submit_failed:${response.status}`);
  }

  return (await response.json()) as MatchingSubmitResponse;
}

async function cancelAtMatchingEngine(body: {
  order_id: string;
  market_id: string;
  side: Side;
  outcome: Outcome;
}) {
  const response = await fetch(`${matchingEngineUrl}/v1/internal/orders/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`matching_engine_cancel_failed:${response.status}`);
  }

  return (await response.json()) as { order_id: string; canceled: boolean };
}

async function reserveAtPortfolioService(body: {
  order_id: string;
  agent_id: string;
  market_id: string;
  side: Side;
  outcome: Outcome;
  price: number;
  size: number;
}) {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/orders/reserve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function settleAtPortfolioService(body: {
  fills: Array<{
    fill_id: string;
    market_id: string;
    outcome: Outcome;
    price: number;
    size: number;
    buy_order_id: string;
    sell_order_id: string;
    buy_agent_id: string;
    sell_agent_id: string;
    buy_limit_price: number;
    sell_limit_price: number;
    executed_at: string;
  }>;
}) {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/orders/settle`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function cancelAtPortfolioService(body: {
  order_id: string;
  agent_id: string;
  market_id: string;
  outcome: Outcome;
  side: Side;
  price: number;
  remaining_size: number;
}) {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/orders/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function appendAcceptedOrderEvent(
  client: PoolClient,
  event: {
    order_id: string;
    agent_id: string;
    market_id: string;
    side: Side;
    outcome: Outcome;
    price: number;
    size: number;
    created_at: string;
  },
) {
  await client.query(
    `
      INSERT INTO order_events (
        event_id,
        event_type,
        order_id,
        market_id,
        agent_id,
        side,
        outcome,
        price,
        size,
        created_at
      )
      VALUES (
        $1, 'accepted', $2, $3, $4, $5, $6, $7, $8, $9::timestamptz
      )
    `,
    [
      randomUUID(),
      event.order_id,
      event.market_id,
      event.agent_id,
      event.side,
      event.outcome,
      event.price,
      event.size,
      event.created_at,
    ],
  );
}

async function insertFillsAndUpdateMarketStats(client: PoolClient, fills: MatchingFill[]) {
  if (fills.length === 0) {
    return;
  }

  for (const fill of fills) {
    await client.query(
      `
        INSERT INTO fills (
          id,
          market_id,
          outcome,
          price,
          size,
          buy_order_id,
          sell_order_id,
          buy_agent_id,
          sell_agent_id,
          executed_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        fill.fill_id,
        fill.market_id,
        fill.outcome,
        fill.price,
        fill.size,
        fill.buy_order_id,
        fill.sell_order_id,
        fill.buy_agent_id,
        fill.sell_agent_id,
        fill.executed_at,
      ],
    );

    await client.query(
      `
        INSERT INTO order_events (
          event_id,
          event_type,
          market_id,
          outcome,
          price,
          size,
          buy_order_id,
          sell_order_id,
          created_at
        )
        VALUES (
          $1, 'fill', $2, $3, $4, $5, $6, $7, $8::timestamptz
        )
      `,
      [
        randomUUID(),
        fill.market_id,
        fill.outcome,
        fill.price,
        fill.size,
        fill.buy_order_id,
        fill.sell_order_id,
        fill.executed_at,
      ],
    );

    const lastTradedYesPrice = fill.outcome === "YES" ? fill.price : 1 - fill.price;
    await client.query(
      `
        UPDATE markets
        SET
          last_traded_price_yes = $2,
          volume_24h = volume_24h + $3
        WHERE id = $1
      `,
      [fill.market_id, lastTradedYesPrice, fill.size],
    );
  }
}

async function appendCanceledOrderEvent(client: PoolClient, order: OrderRow) {
  await client.query(
    `
      INSERT INTO order_events (
        event_id,
        event_type,
        order_id,
        market_id,
        agent_id,
        side,
        outcome,
        price,
        size,
        created_at
      )
      VALUES (
        $1, 'canceled', $2, $3, $4, $5, $6, $7, $8, NOW()
      )
    `,
    [
      randomUUID(),
      order.id,
      order.market_id,
      order.agent_id,
      order.side,
      order.outcome,
      Number(order.price),
      Math.max(Number(order.size) - Number(order.filled_size), 0),
    ],
  );
}

async function projectionGetPortfolio(agent: AgentContext, labels: ExecutionLabels): Promise<BackendResponse> {
  const state = await captureGateStateHash(pool, { agentId: agent.id });
  const snapshot = withExecutionLabels(await getPortfolioSnapshot(pool, agent.id), labels);
  return {
    statusCode: 200,
    body: await withGateToolCall(snapshot, {
      toolName: "portfolio.get",
      agentId: agent.id,
      requestPayload: {
        method: "GET",
        path: "/v1/portfolio",
        ...labels,
      },
      statusCode: 200,
      preState: state,
    }),
  };
}

async function projectionSubmitOrder(
  input: SubmitOrderInput,
  labels: ExecutionLabels,
): Promise<BackendResponse> {
  const { agent, body, idempotencyKey, signedTimestamp, requestSignature } = input;

  if (
    !body.market_id ||
    !body.side ||
    !body.outcome ||
    typeof body.price !== "number" ||
    typeof body.size !== "number" ||
    !body.client_order_id
  ) {
    return {
      statusCode: 400,
      body: withExecutionLabels({ error: "invalid_order_request" }, labels),
    };
  }
  if (!(await ensureMarketExists(body.market_id))) {
    return {
      statusCode: 404,
      body: withExecutionLabels({ error: "market_not_found" }, labels),
    };
  }

  const existing = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );

  if (existing.rowCount) {
    return {
      statusCode: 409,
      body: withExecutionLabels(
        { error: "duplicate_idempotency_key", order: mapOrderRow(existing.rows[0]) },
        labels,
      ),
    };
  }

  const requestPayload = {
    method: "POST",
    path: "/v1/orders",
    body,
    idempotency_key: idempotencyKey,
    ...labels,
  };
  const preGateState = await captureGateStateHash(pool, {
    agentId: agent.id,
    marketId: body.market_id,
  });
  const orderId = randomUUID();
  const orderCreatedAt = new Date().toISOString();
  const reserveResult = await reserveAtPortfolioService({
    order_id: orderId,
    agent_id: agent.id,
    market_id: body.market_id,
    side: body.side,
    outcome: body.outcome,
    price: body.price,
    size: body.size,
  });
  if (!reserveResult.ok) {
    return {
      statusCode: reserveResult.status,
      body: await withGateToolCall(withExecutionLabels(reserveResult.body, labels), {
        toolName: "orders.submit",
        agentId: agent.id,
        requestPayload,
        statusCode: reserveResult.status,
        preState: preGateState,
        postScope: {
          agentId: agent.id,
          marketId: body.market_id,
          orderId,
        },
      }),
    };
  }

  let matchingResult: MatchingSubmitResponse;
  try {
    matchingResult = await submitToMatchingEngine({
      order_id: orderId,
      agent_id: agent.id,
      market_id: body.market_id,
      side: body.side,
      outcome: body.outcome,
      price: body.price,
      size: body.size,
      created_at: orderCreatedAt,
    });
  } catch (error) {
    await cancelAtPortfolioService({
      order_id: orderId,
      agent_id: agent.id,
      market_id: body.market_id,
      outcome: body.outcome,
      side: body.side,
      price: body.price,
      remaining_size: body.size,
    }).catch(() => undefined);
    const responseBody = withExecutionLabels({ error: String(error) }, labels);
    return {
      statusCode: 502,
      body: await withGateToolCall(responseBody, {
        toolName: "orders.submit",
        agentId: agent.id,
        requestPayload,
        statusCode: 502,
        preState: preGateState,
        postScope: {
          agentId: agent.id,
          marketId: body.market_id,
          orderId,
        },
      }),
    };
  }

  const client = await pool.connect();
  const affectedAgentIds = new Set<string>([agent.id]);
  const settlementPayload: Array<{
    fill_id: string;
    market_id: string;
    outcome: Outcome;
    price: number;
    size: number;
    buy_order_id: string;
    sell_order_id: string;
    buy_agent_id: string;
    sell_agent_id: string;
    buy_limit_price: number;
    sell_limit_price: number;
    executed_at: string;
  }> = [];
  try {
    await client.query("BEGIN");

    const takerUpdate =
      matchingResult.touched_orders.find((entry) => entry.order_id === orderId) ??
      ({
        order_id: orderId,
        filled_size: matchingResult.filled_size,
        remaining_size: matchingResult.remaining_size,
        status: matchingResult.status,
      } satisfies MatchingOrderUpdate);

    await client.query(
      `
        INSERT INTO orders (
          id,
          agent_id,
          market_id,
          client_order_id,
          idempotency_key,
          side,
          outcome,
          price,
          size,
          filled_size,
          status,
          signed_at,
          request_signature,
          created_at,
          updated_at,
          canceled_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::timestamptz, $15::timestamptz, NULL
        )
      `,
      [
        orderId,
        agent.id,
        body.market_id,
        body.client_order_id,
        idempotencyKey,
        body.side,
        body.outcome,
        body.price,
        body.size,
        takerUpdate.filled_size,
        takerUpdate.status,
        signedTimestamp,
        requestSignature,
        orderCreatedAt,
        orderCreatedAt,
      ],
    );

    await appendAcceptedOrderEvent(client, {
      order_id: orderId,
      agent_id: agent.id,
      market_id: body.market_id,
      side: body.side,
      outcome: body.outcome,
      price: body.price,
      size: body.size,
      created_at: orderCreatedAt,
    });

    for (const update of matchingResult.touched_orders) {
      if (update.order_id === orderId) {
        continue;
      }

      await client.query(
        `
          UPDATE orders
          SET
            filled_size = $2,
            status = $3,
            updated_at = NOW()
          WHERE id = $1
        `,
        [update.order_id, update.filled_size, update.status],
      );
    }

    await insertFillsAndUpdateMarketStats(client, matchingResult.fills);

    const touchedOrderIds = matchingResult.touched_orders.map((entry) => entry.order_id);
    const touchedOrdersResult = await client.query<OrderRow>(
      `
        SELECT *
        FROM orders
        WHERE id = ANY($1::text[])
      `,
      [touchedOrderIds],
    );

    const touchedOrders = touchedOrdersResult.rows.map(mapOrderRow);
    const orderPriceById = new Map<string, number>();
    for (const order of touchedOrders) {
      orderPriceById.set(order.id, order.price);
    }

    for (const order of touchedOrders) {
      await appendStreamEvent(client, {
        channel: "order.update",
        market_id: order.market_id,
        agent_id: order.agent_id,
        payload: {
          ...order,
          ...labels,
        },
        created_at: order.updated_at,
      });
    }

    for (const fill of matchingResult.fills) {
      settlementPayload.push({
        fill_id: fill.fill_id,
        market_id: fill.market_id,
        outcome: fill.outcome,
        price: fill.price,
        size: fill.size,
        buy_order_id: fill.buy_order_id,
        sell_order_id: fill.sell_order_id,
        buy_agent_id: fill.buy_agent_id,
        sell_agent_id: fill.sell_agent_id,
        buy_limit_price: orderPriceById.get(fill.buy_order_id) ?? body.price,
        sell_limit_price: orderPriceById.get(fill.sell_order_id) ?? body.price,
        executed_at: fill.executed_at,
      });
      await appendStreamEvent(client, {
        channel: "trade.fill",
        market_id: fill.market_id,
        payload: {
          id: fill.fill_id,
          market_id: fill.market_id,
          outcome: fill.outcome,
          price: fill.price,
          size: fill.size,
          buy_order_id: fill.buy_order_id,
          sell_order_id: fill.sell_order_id,
          buy_agent_id: fill.buy_agent_id,
          sell_agent_id: fill.sell_agent_id,
          executed_at: fill.executed_at,
          ...labels,
        },
        created_at: fill.executed_at,
      });
    }

    await appendStreamEvent(client, {
      channel: "orderbook.delta",
      market_id: body.market_id,
      payload: {
        ...(await getOrderbookSnapshot(client, body.market_id)),
        reason: "order_submit",
        touched_order_ids: touchedOrderIds,
        ...labels,
      },
    });

    for (const order of touchedOrders) {
      affectedAgentIds.add(order.agent_id);
    }
    for (const fill of matchingResult.fills) {
      affectedAgentIds.add(fill.buy_agent_id);
      affectedAgentIds.add(fill.sell_agent_id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (settlementPayload.length > 0) {
    const settleResult = await settleAtPortfolioService({ fills: settlementPayload });
    if (!settleResult.ok) {
      const responseBody = withExecutionLabels(
        { error: "portfolio_settlement_failed", details: settleResult.body },
        labels,
      );
      return {
        statusCode: 502,
        body: await withGateToolCall(responseBody, {
          toolName: "orders.submit",
          agentId: agent.id,
          requestPayload,
          statusCode: 502,
          preState: preGateState,
          postScope: {
            agentId: agent.id,
            marketId: body.market_id,
            orderId,
          },
        }),
      };
    }
  }

  for (const affectedAgentId of affectedAgentIds) {
    await appendStreamEvent(pool, {
      channel: "portfolio.update",
      agent_id: affectedAgentId,
      market_id: body.market_id,
      payload: withExecutionLabels(await getPortfolioSnapshot(pool, affectedAgentId), labels),
    });
  }

  const responseBody = withExecutionLabels(
    {
      order_id: orderId,
      client_order_id: body.client_order_id,
      status: matchingResult.status,
      received_at: new Date().toISOString(),
      filled_size: matchingResult.filled_size,
    },
    labels,
  );
  return {
    statusCode: 202,
    body: await withGateToolCall(responseBody, {
      toolName: "orders.submit",
      agentId: agent.id,
      requestPayload,
      statusCode: 202,
      preState: preGateState,
      postScope: {
        agentId: agent.id,
        marketId: body.market_id,
        orderId,
      },
    }),
  };
}

async function projectionCancelOrder(
  input: CancelOrderInput,
  labels: ExecutionLabels,
): Promise<BackendResponse> {
  const { agent, body } = input;
  if (!body.order_id && !body.client_order_id) {
    return {
      statusCode: 400,
      body: withExecutionLabels({ error: "missing_order_identity" }, labels),
    };
  }

  const requestPayload = {
    method: "POST",
    path: "/v1/orders/cancel",
    body,
    ...labels,
  };
  const lookupGateState = await captureGateStateHash(pool, {
    agentId: agent.id,
    orderId: body.order_id ?? null,
  });
  const result = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE agent_id = $1
        AND (id = $2 OR client_order_id = $3)
      LIMIT 1
    `,
    [agent.id, body.order_id ?? null, body.client_order_id ?? null],
  );

  if (!result.rowCount) {
    const responseBody = withExecutionLabels({ status: "not_found" }, labels);
    return {
      statusCode: 404,
      body: await withGateToolCall(responseBody, {
        toolName: "orders.cancel",
        agentId: agent.id,
        requestPayload,
        statusCode: 404,
        preState: lookupGateState,
      }),
    };
  }

  const order = result.rows[0];
  const preGateState = await captureGateStateHash(pool, {
    agentId: agent.id,
    marketId: order.market_id,
    orderId: order.id,
  });
  if (order.status === "canceled" || Number(order.filled_size) >= Number(order.size)) {
    const responseBody = withExecutionLabels({ status: "accepted" }, labels);
    return {
      statusCode: 200,
      body: await withGateToolCall(responseBody, {
        toolName: "orders.cancel",
        agentId: agent.id,
        requestPayload,
        statusCode: 200,
        preState: preGateState,
      }),
    };
  }

  let canceledAtEngine = false;
  try {
    const cancelResult = await cancelAtMatchingEngine({
      order_id: order.id,
      market_id: order.market_id,
      side: order.side,
      outcome: order.outcome,
    });
    canceledAtEngine = cancelResult.canceled;
  } catch (error) {
    const responseBody = withExecutionLabels({ error: String(error) }, labels);
    return {
      statusCode: 502,
      body: await withGateToolCall(responseBody, {
        toolName: "orders.cancel",
        agentId: agent.id,
        requestPayload,
        statusCode: 502,
        preState: preGateState,
        postScope: {
          agentId: agent.id,
          marketId: order.market_id,
          orderId: order.id,
        },
      }),
    };
  }

  if (!canceledAtEngine) {
    const responseBody = withExecutionLabels({ error: "order_not_cancelable_in_matching_engine" }, labels);
    return {
      statusCode: 409,
      body: await withGateToolCall(responseBody, {
        toolName: "orders.cancel",
        agentId: agent.id,
        requestPayload,
        statusCode: 409,
        preState: preGateState,
        postScope: {
          agentId: agent.id,
          marketId: order.market_id,
          orderId: order.id,
        },
      }),
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE orders
        SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [order.id],
    );
    await appendCanceledOrderEvent(client, order);
    const canceledOrderResult = await client.query<OrderRow>(
      `
        SELECT *
        FROM orders
        WHERE id = $1
      `,
      [order.id],
    );
    const canceledOrder = mapOrderRow(canceledOrderResult.rows[0]);
    await appendStreamEvent(client, {
      channel: "order.update",
      market_id: canceledOrder.market_id,
      agent_id: canceledOrder.agent_id,
      payload: {
        ...canceledOrder,
        ...labels,
      },
      created_at: canceledOrder.updated_at,
    });
    await appendStreamEvent(client, {
      channel: "orderbook.delta",
      market_id: canceledOrder.market_id,
      payload: {
        ...(await getOrderbookSnapshot(client, canceledOrder.market_id)),
        reason: "order_cancel",
        touched_order_ids: [canceledOrder.id],
        ...labels,
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const remainingSize = Math.max(Number(order.size) - Number(order.filled_size), 0);
  const portfolioCancelResult = await cancelAtPortfolioService({
    order_id: order.id,
    agent_id: order.agent_id,
    market_id: order.market_id,
    outcome: order.outcome,
    side: order.side,
    price: Number(order.price),
    remaining_size: remainingSize,
  });
  if (!portfolioCancelResult.ok) {
    const responseBody = withExecutionLabels(
      { error: "portfolio_cancel_failed", details: portfolioCancelResult.body },
      labels,
    );
    return {
      statusCode: 502,
      body: await withGateToolCall(responseBody, {
        toolName: "orders.cancel",
        agentId: agent.id,
        requestPayload,
        statusCode: 502,
        preState: preGateState,
        postScope: {
          agentId: agent.id,
          marketId: order.market_id,
          orderId: order.id,
        },
      }),
    };
  }

  await appendStreamEvent(pool, {
    channel: "portfolio.update",
    market_id: order.market_id,
    agent_id: order.agent_id,
    payload: withExecutionLabels(await getPortfolioSnapshot(pool, order.agent_id), labels),
  });

  const responseBody = withExecutionLabels({ status: "accepted" }, labels);
  return {
    statusCode: 202,
    body: await withGateToolCall(responseBody, {
      toolName: "orders.cancel",
      agentId: agent.id,
      requestPayload,
      statusCode: 202,
      preState: preGateState,
      postScope: {
        agentId: agent.id,
        marketId: order.market_id,
        orderId: order.id,
      },
    }),
  };
}

async function projectionGetOrder(input: GetOrderInput, labels: ExecutionLabels): Promise<BackendResponse> {
  const { agent, orderId } = input;
  const state = await captureGateStateHash(pool, { agentId: agent.id, orderId });
  const result = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE id = $1 AND agent_id = $2
    `,
    [orderId, agent.id],
  );

  if (!result.rowCount) {
    const responseBody = withExecutionLabels({ error: "order_not_found" }, labels);
    return {
      statusCode: 404,
      body: await withGateToolCall(responseBody, {
        toolName: "orders.get",
        agentId: agent.id,
        requestPayload: {
          method: "GET",
          path: "/v1/orders/:orderId",
          params: { orderId },
          ...labels,
        },
        statusCode: 404,
        preState: state,
      }),
    };
  }

  const order = mapOrderRow(result.rows[0]);
  const responseBody = withExecutionLabels(
    {
      ...order,
      order_type: "limit",
    },
    labels,
  );
  return {
    statusCode: 200,
    body: await withGateToolCall(responseBody, {
      toolName: "orders.get",
      agentId: agent.id,
      requestPayload: {
        method: "GET",
        path: "/v1/orders/:orderId",
        params: { orderId },
        ...labels,
      },
      statusCode: 200,
      preState: state,
    }),
  };
}

async function projectionListFills(agent: AgentContext, labels: ExecutionLabels): Promise<BackendResponse> {
  const result = await pool.query<FillRow>(
    `
      SELECT *
      FROM fills
      WHERE buy_agent_id = $1 OR sell_agent_id = $1
      ORDER BY executed_at DESC, id DESC
    `,
    [agent.id],
  );

  const state = await captureGateStateHash(pool, { agentId: agent.id });
  const responseBody = withExecutionLabels(
    {
      items: result.rows.map(mapFillRow),
    },
    labels,
  );
  return {
    statusCode: 200,
    body: await withGateToolCall(responseBody, {
      toolName: "fills.list",
      agentId: agent.id,
      requestPayload: {
        method: "GET",
        path: "/v1/fills",
        ...labels,
      },
      statusCode: 200,
      preState: state,
    }),
  };
}

function createProjectionBackend(): ExecutionBackend {
  const labels = executionLabels("projection");
  return {
    mode: "projection",
    backend: "ProjectionBackend",
    labels,
    getPortfolio: (agent) => projectionGetPortfolio(agent, labels),
    submitOrder: (input) => projectionSubmitOrder(input, labels),
    cancelOrder: (input) => projectionCancelOrder(input, labels),
    getOrder: (input) => projectionGetOrder(input, labels),
    listFills: (agent) => projectionListFills(agent, labels),
  };
}

function createLiveBackend(mode: Exclude<ExecutionMode, "projection">): ExecutionBackend {
  const labels = executionLabels(mode);

  async function disabled(
    toolName: GateToolName,
    agent: AgentContext,
    requestPayload: Record<string, unknown>,
    stateScope: { marketId?: string | null; orderId?: string | null } = {},
  ): Promise<BackendResponse> {
    const state = await captureGateStateHash(pool, {
      agentId: agent.id,
      marketId: stateScope.marketId ?? null,
      orderId: stateScope.orderId ?? null,
    });
    const body = liveExecutionDisabledBody(labels);
    return {
      statusCode: 403,
      body: await withGateToolCall(body, {
        toolName,
        agentId: agent.id,
        requestPayload: {
          ...requestPayload,
          ...labels,
        },
        statusCode: 403,
        preState: state,
      }),
    };
  }

  return {
    mode,
    backend: "LiveBackend",
    labels,
    getPortfolio: (agent) => disabled("portfolio.get", agent, {
      method: "GET",
      path: "/v1/portfolio",
    }),
    submitOrder: (input) => disabled("orders.submit", input.agent, {
      method: "POST",
      path: "/v1/orders",
      body: input.body,
      idempotency_key: input.idempotencyKey,
    }, {
      marketId: typeof input.body.market_id === "string" ? input.body.market_id : null,
    }),
    cancelOrder: (input) => disabled("orders.cancel", input.agent, {
      method: "POST",
      path: "/v1/orders/cancel",
      body: input.body,
    }, {
      orderId: input.body.order_id ?? null,
    }),
    getOrder: (input) => disabled("orders.get", input.agent, {
      method: "GET",
      path: "/v1/orders/:orderId",
      params: { orderId: input.orderId },
    }, {
      orderId: input.orderId,
    }),
    listFills: (agent) => disabled("fills.list", agent, {
      method: "GET",
      path: "/v1/fills",
    }),
  };
}

function createExecutionBackend(mode: ExecutionMode): ExecutionBackend {
  if (mode === "projection") {
    return createProjectionBackend();
  }

  return createLiveBackend(mode);
}

function invalidExecutionModeBody(value: unknown) {
  return {
    error: "invalid_execution_mode",
    received: value,
    supported_execution_modes: Array.from(executionModes),
  };
}

app.get("/health", async () => ({ service: "agent-gateway", status: "ok" }));

app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/health") {
    return;
  }

  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    reply.code(401);
    return reply.send({ error: "missing_or_invalid_authorization" });
  }

  const token = authorization.slice("Bearer ".length).trim();
  const introspection = await introspectToken(token);
  if (!introspection.active || !introspection.agent) {
    reply.code(401);
    return reply.send({ error: "inactive_or_unknown_token" });
  }

  request.agentContext = introspection.agent;

  if (request.method !== "POST" || !request.url.startsWith("/v1/orders")) {
    return;
  }

  const agentId = request.headers["x-agent-id"];
  const timestamp = request.headers["x-agent-timestamp"];
  const signature = request.headers["x-agent-signature"];

  if (typeof agentId !== "string" || typeof timestamp !== "string" || typeof signature !== "string") {
    reply.code(400);
    return reply.send({ error: "missing_signed_request_headers" });
  }
  if (agentId !== introspection.agent.id) {
    reply.code(403);
    return reply.send({ error: "token_subject_mismatch" });
  }

  const signedAt = new Date(timestamp).getTime();
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > maxSignatureAgeMs) {
    reply.code(401);
    return reply.send({ error: "stale_or_invalid_request_timestamp" });
  }

  const signedPath = (request as { routerPath?: string }).routerPath ?? request.url;
  const payload = buildSignedPayload(request.method, signedPath, agentId, timestamp, request.body);
  if (!verifyDetachedSignature(introspection.agent.public_key, payload, signature)) {
    reply.code(401);
    return reply.send({ error: "invalid_request_signature" });
  }
});

app.get("/v1/portfolio", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const resolvedMode = resolveExecutionMode(request);
  if (!resolvedMode.ok) {
    reply.code(400);
    return invalidExecutionModeBody(resolvedMode.value);
  }

  const result = await createExecutionBackend(resolvedMode.mode).getPortfolio(agent);
  reply.code(result.statusCode);
  return result.body;
});

app.post("/v1/orders", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }
  const body = (request.body ?? {}) as SubmitOrderRequest;

  const idempotencyKey = request.headers["idempotency-key"];
  const signedTimestamp = request.headers["x-agent-timestamp"];
  const requestSignature = request.headers["x-agent-signature"];

  const resolvedMode = resolveExecutionMode(request);
  if (!resolvedMode.ok) {
    reply.code(400);
    return invalidExecutionModeBody(resolvedMode.value);
  }

  const liveMode = isLiveExecutionMode(resolvedMode.mode) ? resolvedMode.mode : null;
  let liveRiskContext: LiveWriteRiskContext | null = null;
  let promotionArtifact: PromotionArtifactRow | null = null;
  if (liveMode) {
    liveRiskContext = {
      marketId: typeof body.market_id === "string" ? body.market_id : undefined,
      side: sideFromUnknown(body.side),
      outcome: outcomeFromUnknown(body.outcome),
      notional: typeof body.price === "number" && typeof body.size === "number"
        ? body.price * body.size
        : undefined,
    };
    const authorization = await authorizeLiveWrite({
      request,
      agent,
      body,
      mode: liveMode,
      toolName: "orders.submit",
      riskContext: liveRiskContext,
    });
    if (!authorization.ok) {
      await recordDeniedLiveWrite({
        agent,
        mode: liveMode,
        toolName: "orders.submit",
        body,
        riskContext: liveRiskContext,
        denial: authorization.body,
        statusCode: authorization.statusCode,
      });
      reply.code(authorization.statusCode);
      return withExecutionLabels(authorization.body, executionLabels(liveMode));
    }
    promotionArtifact = authorization.artifact;
  }

  if (
    typeof idempotencyKey !== "string" ||
    typeof signedTimestamp !== "string" ||
    typeof requestSignature !== "string"
  ) {
    const responseBody = {
      error: "missing_order_headers",
      message: "Order submission requires idempotency-key, x-agent-timestamp, and x-agent-signature headers.",
    };
    if (liveMode && liveRiskContext && promotionArtifact) {
      await recordDeniedLiveWrite({
        agent,
        mode: liveMode,
        toolName: "orders.submit",
        body,
        riskContext: liveRiskContext,
        denial: {
          ...responseBody,
          promotion_artifact_id: promotionArtifact.id,
          tool_name: "orders.submit",
          execution_mode: liveMode,
          details: {
            artifact_key: promotionArtifact.artifact_key,
          },
        },
        statusCode: 400,
      });
      reply.code(400);
      return withExecutionLabels(
        {
          ...responseBody,
          promotion_artifact_id: promotionArtifact.id,
        },
        executionLabels(liveMode),
      );
    }
    reply.code(400);
    return responseBody;
  }

  const result = await createExecutionBackend(resolvedMode.mode).submitOrder({
    agent,
    body,
    idempotencyKey,
    signedTimestamp,
    requestSignature,
  });
  if (liveMode && liveRiskContext && promotionArtifact && result.statusCode >= 400) {
    const resultBody = result.body as { error?: unknown; message?: unknown };
    await recordDeniedLiveWrite({
      agent,
      mode: liveMode,
      toolName: "orders.submit",
      body,
      riskContext: liveRiskContext,
      denial: {
        error: typeof resultBody.error === "string" ? resultBody.error : "live_write_denied",
        message: typeof resultBody.message === "string"
          ? resultBody.message
          : "Live write was denied by the selected execution backend.",
        promotion_artifact_id: promotionArtifact.id,
        tool_name: "orders.submit",
        execution_mode: liveMode,
        details: {
          artifact_key: promotionArtifact.artifact_key,
        },
      },
      statusCode: result.statusCode,
    });
  }
  reply.code(result.statusCode);
  return result.body;
});

app.post("/v1/orders/cancel", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }
  const body = (request.body ?? {}) as CancelOrderRequest;

  const resolvedMode = resolveExecutionMode(request);
  if (!resolvedMode.ok) {
    reply.code(400);
    return invalidExecutionModeBody(resolvedMode.value);
  }

  const liveMode = isLiveExecutionMode(resolvedMode.mode) ? resolvedMode.mode : null;
  let liveRiskContext: LiveWriteRiskContext | null = null;
  let promotionArtifact: PromotionArtifactRow | null = null;
  if (liveMode) {
    liveRiskContext = await resolveCancelRiskContext(agent, body);
    const authorization = await authorizeLiveWrite({
      request,
      agent,
      body,
      mode: liveMode,
      toolName: "orders.cancel",
      riskContext: liveRiskContext,
    });
    if (!authorization.ok) {
      await recordDeniedLiveWrite({
        agent,
        mode: liveMode,
        toolName: "orders.cancel",
        body,
        riskContext: liveRiskContext,
        denial: authorization.body,
        statusCode: authorization.statusCode,
      });
      reply.code(authorization.statusCode);
      return withExecutionLabels(authorization.body, executionLabels(liveMode));
    }
    promotionArtifact = authorization.artifact;
  }

  const result = await createExecutionBackend(resolvedMode.mode).cancelOrder({
    agent,
    body,
  });
  if (liveMode && liveRiskContext && promotionArtifact && result.statusCode >= 400) {
    const resultBody = result.body as { error?: unknown; message?: unknown };
    await recordDeniedLiveWrite({
      agent,
      mode: liveMode,
      toolName: "orders.cancel",
      body,
      riskContext: liveRiskContext,
      denial: {
        error: typeof resultBody.error === "string" ? resultBody.error : "live_write_denied",
        message: typeof resultBody.message === "string"
          ? resultBody.message
          : "Live write was denied by the selected execution backend.",
        promotion_artifact_id: promotionArtifact.id,
        tool_name: "orders.cancel",
        execution_mode: liveMode,
        details: {
          artifact_key: promotionArtifact.artifact_key,
        },
      },
      statusCode: result.statusCode,
    });
  }
  reply.code(result.statusCode);
  return result.body;
});

app.get("/v1/orders/:orderId", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const resolvedMode = resolveExecutionMode(request);
  if (!resolvedMode.ok) {
    reply.code(400);
    return invalidExecutionModeBody(resolvedMode.value);
  }

  const { orderId } = request.params as { orderId: string };
  const result = await createExecutionBackend(resolvedMode.mode).getOrder({ agent, orderId });
  reply.code(result.statusCode);
  return result.body;
});

app.get("/v1/fills", async (request, reply) => {
  const agent = request.agentContext;
  if (!agent) {
    reply.code(401);
    return { error: "missing_agent_context" };
  }

  const resolvedMode = resolveExecutionMode(request);
  if (!resolvedMode.ok) {
    reply.code(400);
    return invalidExecutionModeBody(resolvedMode.value);
  }

  const result = await createExecutionBackend(resolvedMode.mode).listFills(agent);
  reply.code(result.statusCode);
  return result.body;
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
