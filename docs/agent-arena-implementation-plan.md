# Agent Env And Arena Implementation Plan

## 1. Decision

Automakit should be both:

- an agent execution environment for finding tool-call, state, risk, and market-reasoning errors;
- an arena protocol for comparing agents under explicit, reproducible evaluation regimes.

The environment is the substrate. The arena is the comparative product built on that substrate.

The arena must not claim that live-synced paper trading is real trading performance. Paper orders either:

- do not affect the live market tape,
- affect only a simulated book that diverges from live,
- or become actual live orders.

There is no honest mode where paper orders stay synced to live markets and also causally affect those live markets.

## 2. Product Claim

Automakit should claim:

> We evaluate whether market-facing agents can safely and correctly use production-shaped trading tools under realistic market scenarios, then promote qualified agents into controlled live execution.

Automakit should not claim:

> Agents ranked by projection PnL are proven live traders.

Projection PnL can be one diagnostic metric, but only inside a clearly labeled evaluation regime.

## 3. User Needs

### Agent builders

They need a place where an agent can discover and fix:

- malformed tool calls,
- duplicate orders,
- stale state assumptions,
- incorrect balance and reserve logic,
- bad cancel handling,
- partial-fill mistakes,
- exposure-limit violations,
- confusion between projection and live execution,
- brittle behavior after tool errors.

The primary artifact for them is a debug report and replayable trace.

### Model and agent evaluators

They need comparable rankings across agents and versions.

The primary artifact for them is an arena scorecard with regime, suite version, case hashes, and verifier results.

### Capital owners and operators

They need evidence before granting live permissions.

The primary artifact for them is a promotion decision with risk scopes, expiry, and rollback path.

### Venue and broker partners

They need assurance that order flow is controlled.

The primary artifact for them is an auditable chain from arena run to release gate to promotion artifact to live adapter.

## 4. Evaluation Regimes

Leaderboards must never mix regimes. Every score must declare its regime.

### 4.1 Tool-Call Gym

Purpose: test whether an agent can use tools correctly.

Inputs:

- synthetic but production-shaped portfolios,
- orderbooks,
- market metadata,
- stale data cases,
- auth and permission cases,
- tool failure cases.

Execution:

- agent calls the same gateway tools used in production;
- verifiers inspect tool coverage, ordering, arguments, state hashes, and risk outcomes.

Scores:

- tool validity rate,
- required-tool coverage,
- state-hash coverage,
- idempotency behavior,
- risk violation count,
- recovery after denied writes,
- replay determinism.

This is the first regime to build.

### 4.2 Replay Market Arena

Purpose: compare market reasoning and execution choices on identical market tapes.

Inputs:

- historical Polymarket/Kalshi/orderbook snapshots,
- external probability histories,
- news and resolution evidence,
- fixed start and end windows.

Execution:

- each agent receives the same tape;
- paper orders execute against a declared fill model;
- agent actions do not alter the source tape.

Scores:

- calibration score,
- no-impact counterfactual PnL,
- slippage under declared fill assumptions,
- order discipline,
- risk-adjusted exposure,
- post-resolution correctness.

Required label:

```text
regime: replay_market
market_impact: none
live_claim: false
```

### 4.3 Shadow-Live Arena

Purpose: evaluate agents on current live market context without sending orders.

Inputs:

- current external market priors,
- current orderbook snapshots where available,
- current news and event feeds.

Execution:

- agents make decisions in real time;
- proposed orders are captured but not sent to venues;
- verifiers score tool use immediately;
- market reasoning scores finalize only after future resolution or replay window close.

Scores:

- live-context tool correctness,
- stale-data handling,
- latency budget adherence,
- forecast calibration after outcome,
- counterfactual execution quality under declared assumptions.

Required label:

```text
regime: shadow_live
market_impact: none
live_claim: false
```

### 4.4 Impact Projection Arena

Purpose: evaluate multi-agent interaction and market-impact behavior.

Inputs:

- simulated books seeded from external priors,
- liquidity curves,
- venue-specific fee models,
- scenario shocks.

Execution:

- agents trade in the same simulated market;
- their orders affect simulated prices and other agents' opportunity sets;
- the simulated market is allowed to diverge from live markets.

Scores:

- endogenous projection PnL,
- inventory discipline,
- manipulation resistance,
- liquidity provision quality,
- robustness to adversarial flow.

Required label:

```text
regime: impact_projection
market_impact: simulated
live_claim: false
```

### 4.5 Tiny-Notional Live Arena

Purpose: produce causally real live-execution evidence under strict limits.

Inputs:

- real broker/exchange adapter,
- real venue state,
- approved promotion artifact,
- strict notional and order limits.

Execution:

- only promoted agents can enter;
- orders are real;
- market impact is real;
- every live write requires a scoped promotion artifact.

Scores:

- realized live PnL,
- real fill quality,
- compliance with live risk limits,
- kill-switch behavior,
- operational stability.

Required label:

```text
regime: tiny_notional_live
market_impact: real
live_claim: true
```

## 5. Architecture

```text
external priors / market tapes / news / odds
  -> belief-prior intake
  -> arena case builder
  -> arena service
  -> agent gateway
  -> execution backend
       projection replay
       shadow live
       impact projection
       tiny-notional live
  -> verifier service
  -> scorecard
  -> release gate
  -> promotion artifact
  -> live adapter
```

### 5.1 `arena-service`

New service responsible for:

- suite creation,
- case registration,
- run scheduling,
- agent enrollment,
- execution-regime selection,
- scorecard aggregation,
- leaderboard publishing.

It should not contain market logic or agent reasoning logic.

### 5.2 `arena-case-builder`

Can start inside `arena-service`, then split later if needed.

Responsibilities:

- convert belief priors and external market refs into replay cases;
- bind each case to immutable input hashes;
- generate tool-call gym cases from production-shaped fixtures;
- create hidden verifier manifests.

It must not mirror external markets as Automakit markets by default.

### 5.3 `verifier`

The verifier should remain deterministic.

Responsibilities:

- inspect tool-call events,
- inspect before and after state hashes,
- inspect order, fill, cancel, portfolio, and stream events,
- compute assertion results,
- emit scorecards.

LLMs can generate cases or explanations. They should not be the authority for pass/fail.

### 5.4 `agent-gateway`

The gateway remains the only agent-facing execution facade.

Required additions:

- attach `arena_run_id` to tool-call events;
- reject live write attempts without promotion artifacts;
- return structured, agent-readable errors;
- emit state hashes for every state-changing tool call;
- keep execution semantics stable across projection and live modes.

### 5.5 `release-gate`

Release gate consumes arena scorecards.

Promotion can depend on:

- specific suite versions,
- minimum score thresholds,
- zero hard risk violations,
- required live-write denial evidence,
- replay stability,
- shadow-live observation windows,
- tiny-notional live results when available.

Arena ranking alone must never grant live permissions.

## 6. Persistence Model

Add tables in `packages/persistence`.

### 6.1 `arena_suites`

Stores versioned evaluation suites.

Fields:

- `id`
- `key`
- `version`
- `title`
- `description`
- `visibility`
- `status`
- `scoring_manifest`
- `created_at`
- `updated_at`

Unique key:

- `(key, version)`

### 6.2 `arena_cases`

Stores immutable cases inside a suite.

Fields:

- `id`
- `suite_id`
- `case_key`
- `regime`
- `input_ref`
- `input_hash`
- `market_tape_ref`
- `verifier_manifest`
- `hidden_manifest_ref`
- `created_at`

Unique key:

- `(suite_id, case_key)`

### 6.3 `arena_participants`

Stores agent/model/tool versions being evaluated.

Fields:

- `id`
- `agent_id`
- `agent_version`
- `tool_manifest_hash`
- `model_provider`
- `model_name`
- `metadata`
- `created_at`

Unique key:

- `(agent_id, agent_version, tool_manifest_hash)`

### 6.4 `arena_runs`

Stores one participant running one case or suite.

Fields:

- `id`
- `suite_id`
- `case_id`
- `participant_id`
- `gate_run_id`
- `execution_mode`
- `regime`
- `status`
- `started_at`
- `completed_at`
- `failure_reason`
- `scorecard_id`
- `created_at`

Indexes:

- `(suite_id, participant_id, created_at DESC)`
- `(regime, status, created_at DESC)`
- `(gate_run_id)`

### 6.5 `arena_scorecards`

Stores deterministic scoring output.

Fields:

- `id`
- `arena_run_id`
- `suite_id`
- `participant_id`
- `regime`
- `score_total`
- `score_dimensions`
- `hard_failures`
- `soft_failures`
- `verifier_version`
- `input_hash`
- `created_at`

### 6.6 `arena_leaderboard_entries`

Stores comparable ranking rows.

Fields:

- `id`
- `suite_id`
- `participant_id`
- `regime`
- `score_total`
- `score_dimensions`
- `rank`
- `sample_count`
- `last_run_at`
- `created_at`
- `updated_at`

Unique key:

- `(suite_id, participant_id, regime)`

Never create a global entry that mixes regimes.

### 6.7 `market_tapes`

Stores immutable references to external market snapshots.

Fields:

- `id`
- `source`
- `source_market_id`
- `source_url`
- `window_start`
- `window_end`
- `tape_ref`
- `tape_hash`
- `metadata`
- `created_at`

The tape can live in object storage or a local artifact directory. The DB stores references and hashes.

## 7. API Surface

### 7.1 Arena management

```text
POST /v1/internal/arena/suites
GET  /v1/internal/arena/suites
GET  /v1/internal/arena/suites/:suite_id
POST /v1/internal/arena/suites/:suite_id/cases
GET  /v1/internal/arena/suites/:suite_id/cases
```

### 7.2 Participant enrollment

```text
POST /v1/arena/participants
GET  /v1/arena/participants/:participant_id
```

The participant payload should include:

- `agent_id`
- `agent_version`
- `tool_manifest_hash`
- `model_provider`
- `model_name`
- `metadata`

### 7.3 Runs

```text
POST /v1/arena/runs
GET  /v1/arena/runs/:run_id
GET  /v1/arena/runs/:run_id/trace
GET  /v1/arena/runs/:run_id/debug-report
POST /v1/arena/runs/:run_id/replay
```

Run creation payload:

```json
{
  "suite_id": "suite_tool_gym_v1",
  "participant_id": "participant_123",
  "regime": "tool_call_gym",
  "execution_mode": "projection"
}
```

### 7.4 Scorecards and leaderboards

```text
GET /v1/arena/runs/:run_id/scorecard
GET /v1/arena/leaderboards?suite_id=...&regime=...
```

The leaderboard endpoint must require `regime`.

## 8. Agent Debug Report

The debug report is the main agent-facing artifact.

It should be structured for agents, not humans.

Shape:

```json
{
  "run_id": "arena_run_123",
  "case_id": "case_cancel_after_partial_fill",
  "status": "failed",
  "hard_failures": [
    {
      "code": "cancel_missing_after_partial_fill",
      "tool_name": "orders.cancel",
      "observed_state_hash": "sha256:...",
      "required_behavior": "Cancel remaining quantity after partial fill when exposure limit is reached.",
      "evidence_event_ids": ["evt_1", "evt_2"]
    }
  ],
  "suggested_next_checks": [
    "Read current open order state before submitting replacement orders.",
    "Verify reserved cash after partial fill."
  ],
  "replay": {
    "suite_id": "tool_gym",
    "case_key": "cancel_after_partial_fill",
    "input_hash": "sha256:..."
  }
}
```

The report should not hide failures behind human prose. It should give exact contract violations and event ids.

## 9. Scoring

Scorecards should be multidimensional.

### 9.1 Hard gates

Hard failures set `eligible_for_promotion=false`.

Examples:

- unauthorized live write attempt,
- risk limit violation,
- invalid order schema,
- missing required cancel,
- duplicate order without idempotency key,
- hidden verifier failure,
- unresolved state hash mismatch.

### 9.2 Tool score

Measures:

- valid tool-call rate,
- required tool coverage,
- tool-call ordering,
- idempotency,
- recovery after error,
- state-hash coverage.

### 9.3 Risk score

Measures:

- exposure discipline,
- order notional discipline,
- drawdown discipline in projection,
- correct handling of denied writes,
- no bypass of promotion artifacts.

### 9.4 Market reasoning score

Measures:

- forecast calibration,
- Brier or log score where outcomes resolve,
- reaction to prior changes,
- stale-data detection,
- overconfidence penalty.

### 9.5 Execution quality score

Depends on regime.

Replay market:

- no-impact execution quality,
- slippage under declared fill model,
- order timing.

Impact projection:

- simulated market-impact quality,
- liquidity consumption,
- manipulation resistance.

Tiny-notional live:

- real fill quality,
- realized live slippage,
- realized live PnL.

## 10. Concrete PR Plan

### PR 1: Product boundary and schema

Files:

- `docs/agent-arena-implementation-plan.md`
- `README.md`
- `packages/persistence/src/index.ts`

Work:

- add arena docs;
- add tables for suites, cases, participants, runs, scorecards, leaderboard entries, and market tapes;
- add indexes and uniqueness constraints;
- add migrations using existing persistence style.

Acceptance:

- persistence typecheck passes;
- DB init creates arena tables idempotently.

### PR 2: `arena-service` skeleton

Files:

- `services/arena-service/package.json`
- `services/arena-service/tsconfig.json`
- `services/arena-service/src/index.ts`
- root package scripts if needed.

Work:

- expose suite, case, participant, run, scorecard, and leaderboard endpoints;
- persist records only;
- no market logic yet.

Acceptance:

- service typechecks;
- can create a suite, case, participant, and run locally.

### PR 3: Tool-Call Gym v1

Work:

- define first public suite: `tool_call_gym_v1`;
- implement deterministic cases:
  - invalid order rejected,
  - duplicate client order id,
  - partial fill then cancel,
  - stale portfolio state,
  - live write denied without promotion artifact,
  - risk limit breach,
  - stream replay after disconnect.

Acceptance:

- a test agent can run all cases;
- verifier emits structured debug reports.

### PR 4: Arena run wiring through `agent-gateway`

Work:

- accept `x-arena-run-id`;
- attach arena run id to tool-call ledger events;
- include state hashes in gateway event metadata;
- preserve existing release-gate behavior.

Acceptance:

- every tool call in a gym run can be traced to an arena run;
- missing or invalid arena run ids fail closed only for arena endpoints, not normal gateway use.

### PR 5: Verifier and scorecards

Work:

- implement deterministic verifier manifests;
- compute hard failures and score dimensions;
- persist `arena_scorecards`;
- update leaderboard entries by suite and regime.

Acceptance:

- leaderboard endpoint requires suite and regime;
- mixed-regime leaderboard requests are rejected.

### PR 6: Replay Market Arena v1

Work:

- ingest Polymarket/Kalshi snapshots into `market_tapes`;
- create replay cases from immutable tape windows;
- execute paper orders against declared no-impact fill model;
- compute calibration and execution scores.

Acceptance:

- scorecard includes `market_impact=none`;
- no score is labeled live;
- tape hash is included in every scorecard.

### PR 7: Shadow-Live Arena v1

Work:

- schedule current live-context episodes from belief priors;
- capture proposed orders without sending them;
- finalize market reasoning scores after outcome or window close.

Acceptance:

- scorecard includes `regime=shadow_live`;
- all proposed orders are non-live;
- future settlement is explicit and replayable.

### PR 8: Impact Projection Arena v1

Work:

- seed simulated books from external priors;
- let agents affect simulated prices;
- record divergence from source priors;
- score endogenous behavior separately from replay/shadow-live.

Acceptance:

- scorecard includes `market_impact=simulated`;
- no live-sync claim exists after first simulated fill.

### PR 9: Arena UI

Work:

- add arena console as a first-class view;
- show suites, regimes, participants, runs, scorecards, debug reports, and leaderboards;
- hide or down-rank projection PnL unless inside a labeled scorecard.

Acceptance:

- no global mixed leaderboard exists;
- every score row displays suite version and regime.

### PR 10: Tiny-Notional Live Arena

Work:

- require promotion artifacts;
- route orders to a real live adapter;
- enforce strict notional, market, side, and expiry scopes;
- record live execution events separately from projection events.

Acceptance:

- no live run starts without a valid promotion artifact;
- live scorecards are the only scorecards allowed to claim live PnL.

## 11. What To Remove Or Rewrite

### Remove from product center

- global projection PnL leaderboards,
- fake balance performance claims,
- Polymarket clone positioning,
- any UI that implies paper execution is live execution.

### Rewrite

- `trade-simulator` should become explicit projection liquidity infrastructure or stay disabled by default.
- market views should become case context, not the main product.
- release-gate docs should say that external market mirroring and projection trading are important ingredients, not moats by themselves.

### Keep

- belief-prior intake,
- projection execution,
- fake balances for environment state,
- market proposal agents,
- release-gate promotion artifacts.

These are necessary environment components. They are not sufficient as a product claim unless tied to arena regimes and verifier evidence.

## 12. Acceptance Criteria For The Direction

The direction is implemented when:

- an agent can run a tool-call gym suite and receive exact machine-readable failure reasons;
- two agents can run the same replay suite and get comparable scorecards;
- every scorecard includes suite id, suite version, input hash, regime, and market-impact label;
- leaderboard APIs reject mixed-regime rankings;
- projection PnL is never presented as live PnL;
- release gate can consume arena scorecards as promotion evidence;
- live write access still requires a promotion artifact;
- tiny-notional live results are stored and ranked separately from projection results.

## 13. Naming

Use:

- `Automakit Env` for the execution environment,
- `Automakit Arena` for the comparative evaluation protocol,
- `Tool-Call Gym` for deterministic tool and state tasks,
- `Replay Market Arena` for fixed tape evaluation,
- `Shadow-Live Arena` for live-context non-ordering evaluation,
- `Tiny-Notional Live Arena` for real limited execution.

Avoid:

- "paper trading leaderboard" as the main product,
- "live benchmark" unless orders are actually live,
- "Polymarket clone",
- "projection PnL proves trading skill".
