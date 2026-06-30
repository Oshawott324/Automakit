# Release Gate Implementation Plan

## Product Boundary

The release gate is a production-readiness gate for autonomous agent execution. It is not a substitute trading venue and must not become a paper-only product surface.

The same semantic execution contract should support:

- projection execution against isolated rollout state,
- live execution against real broker/exchange adapters.

Projection runs decide whether an agent/tool/model version can receive live scopes or higher risk limits.

## PR Split

### PR 1: Gate Persistence Schema

Write scope:

- `packages/persistence/src/index.ts`

Deliverables:

- `release_gate_snapshots`
- `release_gate_runs`
- `release_gate_rollouts`
- `release_gate_tool_calls`
- `release_gate_semantic_events`
- verifier result/check tables if needed
- `release_gate_promotion_artifacts`

The schema should be Postgres-native, JSONB-friendly, indexed for run lookup, and explicit about promotion status.

### PR 2: Release Gate Service

Write scope:

- `services/release-gate/`

Deliverables:

- health endpoint
- create/read/verify gate run endpoints
- bounded rollout DB clone helper
- deterministic verifier over current trading state
- promotion artifact creation only after verifier pass

The service should clone projection state and verify behavior. It should not implement a separate trading API.

### PR 3: Agent Gateway Gate Ledger

Write scope:

- `services/agent-gateway/`

Deliverables:

- record gate tool calls when `GATE_RUN_ID` and `GATE_ROLLOUT_ID` are set
- hook key read/write endpoints:
  - `GET /v1/portfolio`
  - `POST /v1/orders`
  - `POST /v1/orders/cancel`
  - `GET /v1/orders/:orderId`
  - `GET /v1/fills`
- preserve production behavior when gate env vars are absent

Ledger recording failures should be observable but should not by themselves break normal endpoint behavior.

### PR 4: Execution Backend Abstraction

Write scope:

- `services/agent-gateway/`
- future venue adapter package/service

Deliverables:

- introduce `ExecutionBackend`
- move the current matching-engine + portfolio flow behind `ProjectionBackend`
- add a disabled-by-default `LiveBackend` boundary
- require valid promotion artifacts before live writes

This PR should come after PR 1-3 so live promotion enforcement has durable state and gate evidence.

## Release Ladder

Promotion artifacts should support a ladder rather than a binary pass:

- `projection_passed`
- `shadow_live`
- `paper_live_market_data`
- `tiny_notional_live`
- `limited_live`

Risk limits must be attached to the artifact, not inferred by the agent.
