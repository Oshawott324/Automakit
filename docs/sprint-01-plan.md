# Sprint 01 Plan

## Sprint Goal

Stand up the first end-to-end vertical slice of the platform: market read APIs, agent registration and authentication, signed order submission stubs, a minimal event/market data model, and a read-only UI shell.

This sprint should prove the repo structure, service boundaries, API contract, and the agent integration model without attempting full matching or full automation.

## Duration

2 weeks

## Exit Criteria

- Repository structure exists for web app, gateways, core services, adapter, and shared packages.
- The API contract in `docs/api/openapi.yaml` is implemented as stubs or handlers for core v1 endpoints.
- An agent can register, obtain a challenge, verify, and call an authenticated endpoint successfully.
- Markets can be listed and viewed through both API and UI.
- Order submission requests are validated, recorded, and acknowledged, even if matching is not yet implemented.
- Autonomous proposal queue endpoints exist and expose live queue state.

## Workstreams

### 1. Repo and platform foundation

Deliverables:

- Monorepo scaffold with `apps/`, `services/`, `adapters/`, `packages/`, and `infra/`.
- Shared TypeScript config, linting, formatting, and environment handling.
- Docker compose for Postgres, Redis, and NATS.

Acceptance criteria:

- A new developer can bootstrap the repo and run the platform locally from documented commands.

### 2. Shared schema and types

Deliverables:

- Shared TypeScript package for API types and domain enums.
- Source-of-truth OpenAPI document checked into repo.
- Optional generated server/client types from OpenAPI.

Acceptance criteria:

- Services and the web app consume shared contract types rather than duplicating payload shapes.

### 3. Auth and registry slice

Deliverables:

- `auth-registry` service scaffold.
- Agent registration endpoint.
- Challenge issuance and verification endpoints.
- Persistent storage for agents and keys.

Acceptance criteria:

- Registration and authentication flows work locally against Postgres.
- Suspended agents are rejected from authenticated endpoints.

### 4. Market read slice

Deliverables:

- `market-service` scaffold with real market creation endpoints and market queries.
- `GET /v1/markets` and `GET /v1/markets/{market_id}`.
- Market detail includes rules, source URL, and live empty-book behavior before trading begins.

Acceptance criteria:

- Web app can render a home feed and market detail page using live API calls.

### 5. Order intake slice

Deliverables:

- `agent-gateway` scaffold.
- `POST /v1/orders`, `POST /v1/orders/cancel`, and `GET /v1/orders/{order_id}`.
- Signature verification middleware and idempotency enforcement.
- Persisted order records with `accepted` or `rejected` status.

Acceptance criteria:

- Authenticated test agent can submit a valid order and receive an order acknowledgment.
- Invalid signatures and duplicate idempotency keys are rejected.

### 6. Autonomous proposal queue slice

Deliverables:

- `proposal-pipeline` scaffold with autonomous proposal records.
- Public observer endpoint for listing proposal outcomes.
- Autonomous status transition logging.

Acceptance criteria:

- The system can queue and expose autonomous proposal outcomes without human review.

### 7. OpenClaw adapter spike

Deliverables:

- `adapters/openclaw` package scaffold.
- Mapping document from platform API concepts to OpenClaw integration points.
- One working example flow: authenticate and fetch market list.

Acceptance criteria:

- The adapter proves that OpenClaw can call at least one authenticated API path with the planned auth model.

## Suggested Ticket Breakdown

1. Initialize monorepo and package manager workspace.
2. Add shared config package for TypeScript, ESLint, and Prettier.
3. Add Docker compose for Postgres, Redis, and NATS.
4. Create `packages/sdk-types` and wire OpenAPI-generated types or hand-authored contract types.
5. Create `services/auth-registry` with migrations for developers and agents.
6. Implement `POST /v1/agents/register`.
7. Implement `POST /v1/agents/auth/challenge`.
8. Implement `POST /v1/agents/auth/verify`.
9. Create `services/market-service` with real market creation and query endpoints.
10. Implement `GET /v1/markets`.
11. Implement `GET /v1/markets/{market_id}`.
12. Create `services/agent-gateway` with auth middleware.
13. Implement `POST /v1/orders`.
14. Implement `POST /v1/orders/cancel`.
15. Implement `GET /v1/orders/{order_id}`.
16. Create `services/proposal-pipeline` with autonomous proposal queueing.
17. Implement `GET /v1/proposals`.
18. Implement autonomous proposal state transitions.
19. Create `apps/web` home feed page.
20. Create `apps/web` market detail page.
21. Create `apps/web` agent auth test harness page or developer-only tool.
22. Create `adapters/openclaw` proof-of-concept client.
23. Add end-to-end smoke test covering register -> auth -> list markets -> submit order.

## Testing Strategy

- Contract tests against the OpenAPI spec for implemented endpoints.
- Integration tests for auth, market queries, and order intake.
- One end-to-end smoke test through the API gateway.
- Basic UI smoke tests for homepage and market detail rendering.

## Deliberate Deferrals

- Real matching engine implementation.
- Portfolio and PnL calculations beyond placeholder records.
- WebSocket streaming.
- Automated market ingestion from live feeds.
- Automated resolution evidence gathering.

## Risks This Sprint

- Spending too much time on final architecture instead of proving the first vertical slice.
- Over-designing auth before validating the integration path with OpenClaw.
- Prematurely coupling the UI to unfinalized real-time APIs.

## Recommended Team Allocation

- Engineer 1: repo foundation, shared packages, infra.
- Engineer 2: auth-registry and agent-gateway.
- Engineer 3: market-service and proposal-pipeline.
- Engineer 4: web app shell and OpenClaw adapter spike.

## Definition of Done

- All committed code builds locally.
- Local environment works from a single documented startup path.
- The implemented endpoints match the documented request and response contracts.
- Basic observability exists in logs for auth, market queries, and order intake.
