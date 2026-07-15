# Overnight Sandbox Arena Implementation Plan

## 1. Decision

Automakit should make `overnight_sandbox` the primary arena regime.

The core product loop is:

```text
market close at T0
  -> freeze today's real market and world data
  -> create an immutable daily case bundle
  -> generate a tomorrow scenario ensemble
  -> run many agents inside an internally causal sandbox
  -> collect trades, tool calls, traces, and scorecards
  -> ingest actual T1 data when it arrives
  -> settle the case and update rankings / release-gate evidence
```

This is both an agent environment and an arena:

- the environment lets agents find tool-call, state, risk, and market-reasoning errors;
- the arena compares agents and versions under a declared, repeatable daily case.

The previous regimes still matter, but they are subordinate:

- `tool_call_gym` is the preflight contract suite for agent tool correctness;
- `replay_market` supplies fixed historical tapes and regression cases;
- `shadow_live` captures current context for later daily bundles;
- `impact_projection` is the market-impact engine inside the overnight sandbox;
- `tiny_notional_live` is the promoted live-execution path after the sandbox and release gate.

## 2. Why Overnight Sandbox Is Primary

Live-paper trading has a causality problem.

Paper orders can either:

- not affect the live market tape;
- affect only a simulated market that diverges from live;
- or become real orders that affect the real venue.

There is no honest mode where fake orders both stay synced to the live market and causally affect it.

The overnight sandbox avoids this contradiction. After close, Automakit does not claim to be live-synced. It freezes real data as of `T0`, creates plausible tomorrow paths, and lets agents trade inside a causal internal environment. When actual `T1` data arrives, the system scores forecasts, behavior, and risk discipline against reality.

## 3. Product Claim

Automakit should claim:

> We freeze real post-close market context, run market-facing agents through production-shaped overnight sandbox cases, then score their tool correctness, risk behavior, forecasts, and execution discipline against next-day reality.

Automakit should not claim:

> Agents ranked by fake balances or live-synced paper PnL are proven live traders.

Sandbox PnL is useful only as one score dimension under an explicit case, scenario set, and market-impact label.

## 4. Primary Regime: `overnight_sandbox`

Required label:

```text
regime: overnight_sandbox
input_data: frozen_after_close
future_data: scenario_ensemble
market_impact: simulated
settlement: next_day_actuals
live_claim: false
```

### 4.1 Inputs

The case builder freezes data after market close:

- external market refs from Polymarket, Kalshi, odds, broker data, or other sources;
- belief prior snapshots and probability histories;
- orderbook snapshots where available;
- close prices and volume;
- relevant news, filings, macro data, social signals, and resolution evidence;
- source hashes and provenance.

External markets are not mirrored as Automakit markets by default. They are source fixtures and priors for a daily case.

### 4.2 Case Bundle

Each case bundle is an immutable filesystem artifact with a database row pointing at it.

Initial local layout:

```text
.automakit/overnight-cases/2026-07-15/
  manifest.json
  source-snapshots/
    external-market-refs.json
    belief-prior-snapshots.json
  belief-priors.json
  market-universe.json
```

The manifest hash is the canonical input identity for reproducibility.
The initial builder does not generate a scenario file; `scenario_ensemble_ref` stays null until scenario generation lands.

### 4.3 Scenario Ensemble

Mock tomorrow data is not truth. It is a scenario ensemble.

Scenario agents generate multiple plausible `T1` paths from the frozen `T0` bundle:

- probability shifts;
- price moves;
- liquidity and spread shocks;
- event updates;
- resolution events;
- news shocks;
- confidence and rationale;
- source evidence refs.

Each scenario has:

- `scenario_key`;
- artifact ref;
- hash;
- probability;
- generator agent id when applicable;
- typed manifest.

The sandbox can run one agent across many scenarios or many agents inside one scenario. Scorecards must record the scenario hashes used.

### 4.4 Sandbox Execution

Agents trade against internal books seeded from the frozen bundle and selected scenario paths.

Within the sandbox:

- orders affect simulated prices;
- balances, positions, reservations, fills, cancels, and fees are fake but production-shaped;
- tool calls go through the same agent gateway contracts used by release-gate runs;
- all state-changing calls produce trace refs and state hashes;
- no live venue write is possible in this regime.

The sandbox is allowed to diverge from live markets after the first simulated fill. That divergence is part of the regime, not a bug.

### 4.5 Settlement

When actual next-day data arrives, Automakit creates an `overnight_settlements` row and settlement artifact.

Settlement scores:

- forecast calibration against actual outcomes;
- directional accuracy;
- risk-adjusted sandbox PnL;
- drawdown and exposure discipline;
- tool-call validity;
- stale-data handling;
- robustness across the scenario ensemble;
- disagreement quality and convergence behavior.

## 5. Supporting Regimes

Leaderboards must never mix regimes. Every score must declare its regime and market-impact label.

### 5.1 `tool_call_gym`

Purpose: preflight agents before overnight runs.

It tests:

- malformed order requests;
- duplicate idempotency keys;
- partial fill then cancel;
- stale portfolio state;
- denied live writes without promotion artifacts;
- risk limit breach;
- stream replay after disconnect.

Tool-call gym can produce release-gate evidence, but it does not evaluate market skill.

### 5.2 `replay_market`

Purpose: regression on fixed historical tapes.

It uses immutable historical source snapshots and no-impact paper fills. It is useful for replaying failures from prior overnight cases and for comparing versions on identical data.

Required label:

```text
regime: replay_market
market_impact: none
live_claim: false
```

### 5.3 `shadow_live`

Purpose: capture current live context without writing orders.

Shadow-live should mainly feed future overnight bundles. It can record proposed actions in real time, but those actions are counterfactual and must not be ranked as live PnL.

Required label:

```text
regime: shadow_live
market_impact: none
live_claim: false
```

### 5.4 `impact_projection`

Purpose: provide the internally causal market-impact engine.

This regime is still useful as a standalone stress test, but its primary role is inside `overnight_sandbox`.

Required label:

```text
regime: impact_projection
market_impact: simulated
live_claim: false
```

### 5.5 `tiny_notional_live`

Purpose: produce causally real live-execution evidence under strict limits.

Only promoted agents can enter. Every live write requires a scoped promotion artifact and a real broker/exchange adapter.

Required label:

```text
regime: tiny_notional_live
market_impact: real
live_claim: true
```

## 6. Architecture

```text
external sources
  -> belief-prior intake
  -> overnight case builder
  -> immutable case bundle
  -> scenario agents
  -> scenario ensemble
  -> overnight sandbox service
  -> agent gateway
  -> projection execution backend
  -> deterministic verifier
  -> overnight scorecards
  -> next-day settlement
  -> release gate evidence
  -> promotion artifact
  -> tiny-notional live adapter
```

### 6.1 `overnight-arena` service

New service responsibility:

- build and register daily case bundles;
- generate scenario ensembles through scenario agents;
- schedule sandbox runs;
- enroll participant agents and versions;
- persist run metadata and artifact refs;
- call verifier workers;
- publish scorecards and settlement status.

The service orchestrates. It should not contain strategy logic.

### 6.2 Case builder

The case builder should be deterministic after source capture.

Responsibilities:

- read belief priors and external market refs;
- write source snapshots into the case artifact directory;
- create `market-universe.json`;
- create `belief-priors.json`;
- write a manifest with source hashes;
- persist `overnight_case_bundles`.

It must not create Automakit tradable markets merely because Polymarket or another source has a market.
It must refuse to build if persisted source rows are absent, returning `overnight_case_source_data_empty` instead of fake fixtures.

### 6.3 Scenario agents

Scenario agents create plausible tomorrow paths as typed artifacts.

They should use code when useful:

```ts
type OvernightScenario = {
  scenario_key: string;
  probability: number;
  market_shocks: Array<{
    source_market_id: string;
    outcome_id: string;
    probability_delta: number;
    liquidity_delta: number | null;
  }>;
  event_updates: Array<{
    event_ref: string;
    update_kind: string;
    summary: string;
    evidence_refs: string[];
  }>;
  rationale: string;
};
```

The runtime should validate the artifact shape. It should not patch invalid scenarios with heuristics.

### 6.4 Sandbox runner

The runner executes agents against a production-shaped projection backend.

Responsibilities:

- create fake but explicit starting cash;
- seed sandbox books from the case bundle and scenario;
- route agent actions through the gateway;
- persist portfolio/action trace artifact refs;
- emit scorecard inputs.

### 6.5 Verifier

The verifier remains deterministic.

Responsibilities:

- inspect tool-call events;
- inspect state hashes;
- inspect orders, fills, cancels, balances, and risk limits;
- compare forecasts against settlement data when available;
- compute scorecards.

LLMs can explain failures or generate scenarios. They should not be the authority for pass/fail.

## 7. Persistence Model

PR1 adds the overnight sandbox foundation to `packages/persistence/src/index.ts`.

### 7.1 `overnight_case_bundles`

One immutable post-close daily case.

Fields:

- `id`
- `case_date`
- `case_key`
- `status`
- `close_captured_at`
- `artifact_root`
- `manifest_path`
- `manifest_hash`
- `source_snapshot_refs`
- `market_universe_ref`
- `belief_prior_ref`
- `scenario_ensemble_ref`
- `metadata`
- `created_at`
- `updated_at`

Constraints and indexes:

- unique `case_date`;
- unique `case_key`;
- index `(status, case_date DESC)`.

### 7.2 `overnight_scenarios`

One generated tomorrow path for a case bundle.

Fields:

- `id`
- `case_bundle_id`
- `scenario_key`
- `scenario_agent_id`
- `scenario_ref`
- `scenario_hash`
- `probability`
- `manifest`
- `created_at`

Constraints and indexes:

- foreign key to `overnight_case_bundles`;
- unique `(case_bundle_id, scenario_key)`;
- index `case_bundle_id`.

### 7.3 `overnight_sandbox_runs`

One coordinated sandbox execution for a case bundle.

Fields:

- `id`
- `case_bundle_id`
- `run_key`
- `status`
- `execution_mode`
- `sandbox_manifest`
- `started_at`
- `completed_at`
- `failure_reason`
- `created_at`
- `updated_at`

Constraints and indexes:

- foreign key to `overnight_case_bundles`;
- unique `run_key`;
- index `(case_bundle_id, status, created_at DESC)`.

### 7.4 `overnight_agent_runs`

One participant agent inside an overnight sandbox run.

Fields:

- `id`
- `sandbox_run_id`
- `participant_agent_id`
- `participant_version`
- `status`
- `starting_cash`
- `sandbox_portfolio_ref`
- `action_trace_ref`
- `scorecard_id`
- `started_at`
- `completed_at`
- `failure_reason`
- `created_at`
- `updated_at`

Constraints and indexes:

- foreign key to `overnight_sandbox_runs`;
- foreign key to `agents`;
- nullable foreign key to `overnight_scorecards`;
- index `(sandbox_run_id, status, created_at DESC)`;
- index `(participant_agent_id, created_at DESC)`.

### 7.5 `overnight_scorecards`

Deterministic scoring output for a run or agent run.

Fields:

- `id`
- `sandbox_run_id`
- `agent_run_id`
- `case_bundle_id`
- `score_total`
- `score_dimensions`
- `hard_failures`
- `soft_failures`
- `verifier_version`
- `input_manifest_hash`
- `scenario_hashes`
- `market_impact_label`
- `live_claim`
- `created_at`

Constraints and indexes:

- foreign key to `overnight_sandbox_runs`;
- nullable foreign key to `overnight_agent_runs`;
- foreign key to `overnight_case_bundles`;
- default `live_claim=false`;
- index `(case_bundle_id, created_at DESC)`;
- index `agent_run_id`.

### 7.6 `overnight_settlements`

Actual next-day data and settlement manifest for a case bundle.

Fields:

- `id`
- `case_bundle_id`
- `settlement_key`
- `actual_data_ref`
- `actual_data_hash`
- `settlement_manifest`
- `settled_at`
- `created_at`

Constraints and indexes:

- foreign key to `overnight_case_bundles`;
- unique `settlement_key`;
- index `(case_bundle_id, settled_at DESC)`.

## 8. API Surface

Current and planned `overnight-arena` service endpoints:

```text
POST /v1/internal/overnight/cases/build
GET  /v1/internal/overnight/cases
POST /v1/internal/overnight/cases
GET  /v1/internal/overnight/cases/:case_bundle_id
POST /v1/internal/overnight/cases/:case_bundle_id/scenarios
GET  /v1/internal/overnight/cases/:case_bundle_id/scenarios
POST /v1/internal/overnight/cases/:case_bundle_id/settlements
GET  /v1/internal/overnight/cases/:case_bundle_id/settlements
GET  /v1/internal/overnight/runs
POST /v1/internal/overnight/runs
GET  /v1/internal/overnight/runs/:run_id
GET  /v1/internal/overnight/runs/:run_id/agent-runs
POST /v1/internal/overnight/runs/:run_id/agent-runs
GET  /v1/internal/overnight/runs/:run_id/scorecards
POST /v1/internal/overnight/runs/:run_id/scorecards
GET  /v1/arena/overnight/:case_date/leaderboard
```

Leaderboard endpoints must be scoped by case date or case bundle id. There should be no global fake-balance leaderboard.

Implemented PR3 builder endpoint:

```text
POST /v1/internal/overnight/cases/build
```

Required body:

- `case_date` as `YYYY-MM-DD`;
- `close_captured_at` as an ISO timestamp.

Optional body:

- `case_key`;
- `artifact_root`;
- `source_limit`;
- `belief_prior_limit`;
- `status`;
- `metadata`.

The endpoint writes deterministic JSON under the artifact root, hashes `manifest.json`, and upserts `overnight_case_bundles` by `case_key`. It only uses persisted `external_market_refs` and `belief_prior_snapshots`; no scenario generation or trading logic runs in the builder.

Implemented PR4 registration endpoints:

```text
GET  /v1/internal/overnight/cases/:case_bundle_id/scenarios
POST /v1/internal/overnight/cases/:case_bundle_id/scenarios
GET  /v1/internal/overnight/runs/:run_id/agent-runs
POST /v1/internal/overnight/runs/:run_id/agent-runs
GET  /v1/internal/overnight/runs/:run_id/scorecards
POST /v1/internal/overnight/runs/:run_id/scorecards
GET  /v1/internal/overnight/cases/:case_bundle_id/settlements
POST /v1/internal/overnight/cases/:case_bundle_id/settlements
```

These endpoints register metadata and evidence refs only. They validate case, run, agent, and agent-run relationships; enforce finite numeric fields; default scorecards to `live_claim=false` with `market_impact_label=simulated_after_close`; and reject any overnight scorecard live claim with `overnight_scorecard_live_claim_forbidden`. They do not generate scenarios, execute trades, compute verifier scores, ingest actual data, or fabricate fallback data.

## 9. Agent Debug Report

The debug report is the main agent-facing artifact.

Shape:

```json
{
  "case_bundle_id": "case_2026_07_15",
  "sandbox_run_id": "overnight_run_123",
  "agent_run_id": "agent_run_456",
  "status": "failed",
  "hard_failures": [
    {
      "code": "stale_prior_used_after_scenario_update",
      "tool_name": "orders.submit",
      "observed_state_hash": "sha256:...",
      "required_behavior": "Read the scenario-adjusted market state before submitting an order.",
      "evidence_refs": ["trace://overnight_run_123/events/18"]
    }
  ],
  "score_dimensions": {
    "tool": 0.72,
    "risk": 0.88,
    "forecast": 0.41,
    "execution": 0.64
  },
  "replay": {
    "manifest_hash": "sha256:...",
    "scenario_hashes": ["sha256:..."]
  }
}
```

The report should expose exact machine-readable contract violations and evidence refs. It should not hide failures behind human-only prose.

## 10. Scoring

Scorecards are multidimensional.

### 10.1 Hard failures

Hard failures set `eligible_for_promotion=false`.

Examples:

- unauthorized live write attempt;
- risk limit violation;
- invalid order schema;
- duplicate order without idempotency key;
- hidden verifier failure;
- unresolved state hash mismatch;
- forecast artifact missing required source refs.

### 10.2 Tool score

Measures:

- valid tool-call rate;
- required tool coverage;
- tool-call ordering;
- idempotency;
- recovery after denied writes;
- state-hash coverage.

### 10.3 Risk score

Measures:

- exposure discipline;
- order notional discipline;
- drawdown discipline;
- correct handling of denied writes;
- no bypass of promotion artifacts.

### 10.4 Forecast score

Measures:

- calibration against actual T1 data;
- Brier or log score where outcomes resolve;
- reaction to scenario updates;
- stale-data detection;
- overconfidence penalty.

### 10.5 Execution score

Measures:

- sandbox fill quality under declared mechanics;
- simulated market-impact quality;
- liquidity consumption;
- inventory discipline;
- consistency across scenario ensemble paths.

## 11. Concrete PR Plan

### PR 1: Overnight product boundary and schema

Files:

- `docs/agent-arena-implementation-plan.md`
- `README.md`
- `packages/persistence/src/index.ts`

Work:

- make `overnight_sandbox` the primary arena regime;
- keep prior regimes as supporting tools;
- add overnight case, scenario, run, agent-run, scorecard, and settlement tables;
- add indexes and uniqueness constraints using existing persistence style.

Acceptance:

- `pnpm --filter @automakit/persistence typecheck` passes;
- `git diff --check` passes.

### PR 2: Overnight arena metadata service

Work:

- create `services/overnight-arena`;
- expose health, case metadata, and sandbox run metadata endpoints;
- allow explicit case bundle registration for already-built artifacts.

Acceptance:

- `pnpm --filter @automakit/overnight-arena typecheck` passes;
- metadata endpoints can list and fetch case bundle rows.

### PR 3: Case bundle builder

Work:

- add `POST /v1/internal/overnight/cases/build`;
- build a case bundle from persisted belief priors and external market refs;
- write deterministic local artifact directories;
- persist or update `overnight_case_bundles`;
- leave `scenario_ensemble_ref` null.

Acceptance:

- one request creates a case bundle for a chosen date;
- manifest hash is stable for identical inputs;
- empty source tables fail closed with `overnight_case_source_data_empty`.

### PR 4: Metadata and evidence registration endpoints

Work:

- add scenario registration and listing endpoints;
- upsert `overnight_scenarios` by `(case_bundle_id, scenario_key)`;
- add agent-run registration and listing endpoints;
- add scorecard registration and listing endpoints with overnight-safe defaults;
- add settlement registration and listing endpoints;
- upsert `overnight_settlements` by `settlement_key`;
- validate referenced case bundles, sandbox runs, agents, and agent runs;
- reject `live_claim=true` for overnight scorecards;
- avoid scenario generation, trading logic, verifier computation, actual-data ingestion, and fake data.

Acceptance:

- invalid registration payloads fail closed with structured agent-readable errors;
- scorecard defaults include the case bundle manifest hash, empty scenario hashes, `market_impact_label=simulated_after_close`, and `live_claim=false`;
- `pnpm --filter @automakit/overnight-arena typecheck` passes;
- `git diff --check` passes.

### PR 5: Scenario ensemble generation

Work:

- define scenario artifact schema;
- call scenario agents to generate tomorrow paths;
- validate artifacts strictly;
- persist registered `overnight_scenarios`;
- write `scenario-ensemble.json`;
- update the case bundle `scenario_ensemble_ref`.

Acceptance:

- invalid scenario artifacts fail closed with agent-readable errors;
- scenario hashes appear in the case bundle.

### PR 6: Sandbox runner

Work:

- seed simulated books from case plus scenario;
- create starting cash and portfolio refs;
- route agent tool calls through the gateway;
- persist or update `overnight_sandbox_runs` and `overnight_agent_runs`;
- write action traces.

Acceptance:

- at least one registered agent can complete an overnight sandbox run locally.

### PR 7: Deterministic verifier and scorecards

Work:

- compute tool, risk, forecast, and execution dimensions;
- persist computed `overnight_scorecards`;
- generate agent debug reports.

Acceptance:

- scorecards include input manifest hash, scenario hashes, market-impact label, and `live_claim=false`.

### PR 8: Settlement artifact ingestion

Work:

- ingest actual next-day data;
- write settlement artifacts;
- persist or update `overnight_settlements`;
- update forecast and execution scores after actuals arrive.

Acceptance:

- a closed case can move from `pending_settlement` to `settled`.

### PR 9: Overnight leaderboard

Work:

- publish case-scoped rankings;
- show score dimensions and hard failures;
- prohibit global mixed-regime PnL ranking.

Acceptance:

- every leaderboard query is scoped by case date or bundle id.

### PR 10: Release-gate integration

Work:

- allow release gate snapshots to reference overnight scorecards;
- require zero hard failures for promotion evidence;
- keep live-write promotion artifact checks unchanged.

Acceptance:

- overnight success can support promotion but cannot bypass live artifact rules.

### PR 9: Tiny-notional live bridge

Work:

- admit only promoted agents;
- enforce live adapter risk limits;
- record real live results separately from sandbox scorecards.

Acceptance:

- only tiny-notional live scorecards can claim `live_claim=true`.

## 12. What To Remove Or Rewrite

Remove from product center:

- global projection PnL leaderboards;
- fake balance performance claims;
- Polymarket clone positioning;
- any UI that implies paper execution is live execution.

Rewrite:

- `trade-simulator` should become explicit sandbox liquidity infrastructure or stay disabled by default;
- market views should become case context, not the main product;
- release-gate docs should say external market mirroring and projection trading are ingredients, not moats by themselves.

Keep:

- belief-prior intake;
- projection execution;
- fake balances for environment state;
- market proposal agents;
- release-gate promotion artifacts.

These are necessary environment components. They are not sufficient as a product claim unless tied to overnight cases, scorecards, settlement, and verifier evidence.

## 13. Acceptance Criteria For The Direction

The direction is implemented when:

- Automakit can freeze an after-close daily case bundle with source hashes;
- scenario agents can generate validated tomorrow paths;
- many agents can trade in an internally causal sandbox;
- every scorecard includes case id, manifest hash, scenario hashes, market-impact label, and `live_claim`;
- actual next-day data can settle the case;
- leaderboards are scoped to case date or case bundle;
- projection PnL is never presented as live PnL;
- release gate can consume overnight scorecards as promotion evidence;
- live write access still requires a promotion artifact.

## 14. Naming

Use:

- `Automakit Overnight Sandbox` for the primary daily arena;
- `Automakit Env` for the execution environment;
- `Automakit Arena` for the comparative evaluation protocol;
- `Tool-Call Gym` for deterministic tool and state tasks;
- `Replay Market` for fixed tape regression;
- `Shadow-Live Capture` for live-context data capture without order writes;
- `Tiny-Notional Live` for real limited execution.

Avoid:

- "paper trading leaderboard" as the main product;
- "live benchmark" unless orders are actually live;
- "Polymarket clone";
- "projection PnL proves trading skill".
