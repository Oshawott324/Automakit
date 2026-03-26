#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${LOG_DIR:-/tmp/automakit-native-e2e-$$}"
DB_PORT="${DB_PORT:-55432}"
RUNTIME_PORT="${RUNTIME_PORT:-4016}"
ORCH_PORT="${ORCH_PORT:-4013}"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${DB_PORT}/postgres"
PSQL_URL="${DATABASE_URL}?sslmode=disable&connect_timeout=3"

mkdir -p "$LOG_DIR"

cleanup() {
  set +e
  if [[ -n "${ORCH_PID:-}" ]]; then kill "$ORCH_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${RUNTIME_PID:-}" ]]; then kill "$RUNTIME_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${PGLITE_PID:-}" ]]; then kill "$PGLITE_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

node_modules/.bin/pglite-server \
  --db "$LOG_DIR/pglite" \
  --host 127.0.0.1 \
  --port "$DB_PORT" \
  --max-connections=40 \
  >"$LOG_DIR/pglite.log" 2>&1 &
PGLITE_PID=$!

echo "Starting pglite-server on port ${DB_PORT}..."
for i in $(seq 1 60); do
  if psql -w "$PSQL_URL" -c "select 1" >/dev/null 2>&1; then
    echo "pglite-server is ready."
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    echo "pglite did not start" >&2
    cat "$LOG_DIR/pglite.log" >&2 || true
    exit 1
  fi
done

set -a
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env >/dev/null 2>&1 || true
fi
set +a

if [[ -z "${LLM_API_KEY:-}" && -n "${OPENAI_API_KEY:-}" ]]; then
  export LLM_API_KEY="$OPENAI_API_KEY"
fi
if [[ -z "${LLM_API_KEY:-}" && -n "${AGENT_OPENAI_API_KEY:-}" ]]; then
  export LLM_API_KEY="$AGENT_OPENAI_API_KEY"
fi

if [[ -z "${LLM_API_KEY:-}" ]]; then
  echo "LLM_API_KEY is not set in environment/.env" >&2
  exit 1
fi

export DATABASE_URL
export SIMULATION_RUNTIME_BACKEND=camel_oasis_http
export SIMULATION_RUNTIME_URL="http://127.0.0.1:${RUNTIME_PORT}"
export SIMULATION_RUNTIME_SUBMIT_TIMEOUT_MS=30000
export SIMULATION_RUNTIME_REQUEST_TIMEOUT_MS=180000
export SIMULATION_RUNTIME_RUN_TIMEOUT_MS=300000
export SIMULATION_RUNTIME_POLL_INTERVAL_MS=1000
export SIMULATION_ORCHESTRATOR_PORT="$ORCH_PORT"
export SIMULATION_ORCHESTRATOR_INTERVAL_MS=999999
export SIMULATION_RUNTIME_WORLD_MODEL_ROLES=world-model-alpha
export SIMULATION_RUNTIME_SCENARIO_ROLES=scenario-base
export SIMULATION_RUNTIME_SYNTHESIS_ROLES=synthesis-core

export SIM_RUNTIME_ENABLE_CAMEL_OASIS=true
export SIM_RUNTIME_ALLOW_DIRECT_LLM=false
export SIM_RUNTIME_CAMEL_OASIS_PLATFORM=twitter
export SIM_RUNTIME_CAMEL_OASIS_ROUNDS=1
export SIM_RUNTIME_CAMEL_OASIS_MIN_ACTIVE_AGENTS=2
export SIM_RUNTIME_CAMEL_OASIS_MAX_ACTIVE_AGENTS=3
export SIM_RUNTIME_CAMEL_OASIS_SEMAPHORE=8
export SIM_RUNTIME_CAMEL_OASIS_RANDOM_SEED=42

services/simulation-runtime-py/.venv/bin/uvicorn app.main:app \
  --app-dir services/simulation-runtime-py \
  --host 127.0.0.1 \
  --port "$RUNTIME_PORT" \
  >"$LOG_DIR/runtime.log" 2>&1 &
RUNTIME_PID=$!
echo "Starting simulation-runtime-py on port ${RUNTIME_PORT}..."

for i in $(seq 1 60); do
  if curl -sS "http://127.0.0.1:${RUNTIME_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    echo "simulation-runtime-py did not start" >&2
    cat "$LOG_DIR/runtime.log" >&2 || true
    exit 1
  fi
done

./node_modules/.bin/tsx services/simulation-orchestrator/src/index.ts >"$LOG_DIR/orchestrator.log" 2>&1 &
ORCH_PID=$!
echo "Starting simulation-orchestrator on port ${ORCH_PORT}..."

for i in $(seq 1 60); do
  if curl -sS "http://127.0.0.1:${ORCH_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    echo "simulation-orchestrator did not start" >&2
    cat "$LOG_DIR/orchestrator.log" >&2 || true
    exit 1
  fi
done

NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
psql -w "$PSQL_URL" -v ON_ERROR_STOP=1 -c "
INSERT INTO world_signals (
  id, source_type, source_adapter, source_id, source_url, trust_tier,
  title, summary, payload, entity_refs, dedupe_key, fetched_at, effective_at, created_at
) VALUES (
  'sig-native-e2e-1',
  'price_feed',
  'http_json_price',
  'btc-native-e2e',
  'https://example.com/btc-native-e2e',
  'exchange',
  'BTC native simulation signal',
  'BTC crossed local threshold in feed',
  '{\"kind\":\"price_threshold\",\"asset_symbol\":\"BTC\",\"price\":72000,\"target_time\":\"2026-12-31T00:00:00Z\"}'::jsonb,
  '[{\"kind\":\"asset\",\"value\":\"BTC\"}]'::jsonb,
  'dedupe-native-e2e-1',
  '${NOW_ISO}'::timestamptz,
  '${NOW_ISO}'::timestamptz,
  '${NOW_ISO}'::timestamptz
)
ON CONFLICT (dedupe_key) DO NOTHING;
" >/dev/null

FINAL_STATUS=""
for i in $(seq 1 50); do
  curl -sS -X POST "http://127.0.0.1:${ORCH_PORT}/v1/internal/simulation-orchestrator/run-once" >/dev/null
  FINAL_STATUS="$(psql -w "$PSQL_URL" -At -c "select status from simulation_runs order by started_at desc limit 1;")"
  echo "tick=${i} status=${FINAL_STATUS}"
  if [[ "$FINAL_STATUS" == "ready_for_proposal" || "$FINAL_STATUS" == "completed" || "$FINAL_STATUS" == "failed" ]]; then
    break
  fi
  sleep 1
done

echo "--- simulation run ---"
psql -w "$PSQL_URL" -At -c "select id,status,coalesce(failure_reason,'') from simulation_runs order by started_at desc limit 1;"
echo "--- runtime run ---"
psql -w "$PSQL_URL" -At -c "select backend,status,coalesce(last_error,'') from simulation_runtime_runs order by created_at desc limit 1;"
echo "--- persisted outputs ---"
psql -w "$PSQL_URL" -At -c "select 'world_state_proposals='||count(*) from world_state_proposals;"
psql -w "$PSQL_URL" -At -c "select 'belief_hypothesis_proposals='||count(*) from belief_hypothesis_proposals;"
psql -w "$PSQL_URL" -At -c "select 'scenario_path_proposals='||count(*) from scenario_path_proposals;"
psql -w "$PSQL_URL" -At -c "select 'synthesized_beliefs='||count(*) from synthesized_beliefs;"
echo "--- runtime health ---"
curl -sS "http://127.0.0.1:${RUNTIME_PORT}/health"
echo
echo "--- orchestrator health ---"
curl -sS "http://127.0.0.1:${ORCH_PORT}/health"
echo

if [[ "$FINAL_STATUS" != "ready_for_proposal" && "$FINAL_STATUS" != "completed" ]]; then
  echo "E2E run failed with status=${FINAL_STATUS}" >&2
  echo "--- runtime log tail ---" >&2
  tail -n 160 "$LOG_DIR/runtime.log" >&2 || true
  echo "--- orchestrator log tail ---" >&2
  tail -n 160 "$LOG_DIR/orchestrator.log" >&2 || true
  exit 1
fi

echo "E2E native CAMEL/Oasis simulation through orchestrator: SUCCESS"
