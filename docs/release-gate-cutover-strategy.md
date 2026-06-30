# Release Gate Cutover Strategy

## 1. First-Principles Product Boundary

Automakit should not become a mock prediction market.

The product should answer one hard question:

> Can this autonomous agent be trusted with a narrowly scoped live execution permission?

Projection execution exists only to produce evidence for that question. It is not the destination, the leaderboard surface, or the product claim.

## 2. What People Need

### Agent developers

They need a production-shaped place to test agents before live capital:

- same tool contract as production,
- replayable failures,
- clear verifier output,
- scoped promotion artifacts,
- cheap iteration without teaching the agent a toy interface.

### Capital owners and operators

They need a reason to grant live permissions:

- proof that the agent respects risk limits,
- proof that it handles stale data, partial fills, cancels, and resolution events,
- proof that behavior is stable across replays and adversarial scenarios,
- a kill switch and expiry on every permission.

### Venue, broker, and infrastructure partners

They need controlled order flow:

- auditable identity,
- scoped permissions,
- pre-trade risk checks,
- clear separation between projection state and live venue state,
- evidence that an agent version passed a release gate before live writes.

### Researchers

They need durable behavior data:

- agent action traces,
- tool-call context,
- state hashes,
- verifier outcomes,
- promotion and rollback history.

## 3. What Is Not The Moat

These are useful, but not defensible enough:

- mirroring Polymarket markets,
- pulling Polymarket probabilities,
- running fake trading with fake balances,
- ranking agents by projection PnL,
- generic LLM-generated market proposals,
- a Polymarket-like UI.

Anyone can ingest public markets and run a toy exchange. That path recreates the failure mode we want to avoid.

## 4. The Moat

### Semantic execution facade

Agents use one production-shaped contract for:

- projection execution,
- shadow live execution,
- tiny-notional live execution,
- limited live execution.

The backend changes; the agent-facing semantics do not.

### Release-gate evidence

Every gate run should produce durable evidence:

- tool calls,
- before/after state hashes,
- order/fill/cancel/portfolio ledgers,
- risk-limit checks,
- hidden verifier cases,
- semantic event traces,
- pass/fail verdicts.

### Promotion artifacts

Live access is granted only through explicit artifacts:

- agent id,
- agent version or tool version,
- approved scopes,
- venue/backend,
- market types,
- notional limits,
- order limits,
- expiry,
- rollback reason if revoked.

No promotion artifact means no live write.

### Behavior corpus

The durable dataset of agent behavior is the long-term advantage:

- how agents fail,
- how they recover,
- when they overfit,
- when they exploit projection quirks,
- how behavior changes across model/tool versions.

This corpus compounds over time and is harder to copy than public belief priors.

## 5. Role Of Polymarket And Other External Sources

External markets should be inputs, not the product.

Use sources like Polymarket, Kalshi, odds feeds, news feeds, and social feeds as belief priors:

```text
external markets / news / odds / social
  -> belief priors
  -> scenario and projection inputs
  -> agent execution through semantic facade
  -> verifier checks
  -> promotion artifact
  -> controlled live adapter
```

Polymarket prices can help create realistic scenarios:

- crowd-implied probabilities,
- liquidity regimes,
- event timing,
- volatility around new information,
- manipulation or thin-book cases.

They must not become:

- copied markets presented as our own exchange,
- fake live performance baselines,
- the source of truth for settlement,
- proof that our agents can execute safely.

## 6. What To Remove Or Disable

### Remove from product positioning

- "prediction market platform" as the primary identity.
- "paper trading beta" as the release target.
- projection PnL as a product-level leaderboard.
- Polymarket parity as a north-star.
- any wording that treats simulation success as production readiness.

### Disable by default

- `market-creator` legacy feed-to-market bridge.
- autonomous `trade-simulator` liquidity loops.
- native CAMEL/Oasis runtime.
- direct LLM simulation mode.
- any market-automation profile that starts with plain `pnpm dev`.

These can remain as explicit development tools, but they should not be part of the default execution/gate runtime.

### Archive or rewrite later

- any UI that centers fake market performance.
- any docs that describe the system as a mock exchange.
- any service whose only purpose is to make projection markets look busy.
- mixed projection/live rankings.

Projection activity should be visible as gate evidence, not as a fake public market.

## 7. What To Rewrite

### Rewrite `agent-gateway` around execution backends

Introduce a first-class backend boundary:

```ts
type ExecutionMode = "projection" | "shadow_live" | "tiny_notional_live" | "limited_live";

type ExecutionBackend = {
  mode: ExecutionMode;
  getPortfolio(input: GetPortfolioInput): Promise<GetPortfolioOutput>;
  submitOrder(input: SubmitOrderInput): Promise<SubmitOrderOutput>;
  cancelOrder(input: CancelOrderInput): Promise<CancelOrderOutput>;
  getOrder(input: GetOrderInput): Promise<GetOrderOutput>;
  listFills(input: ListFillsInput): Promise<ListFillsOutput>;
};
```

The current matching-engine plus portfolio-service flow becomes `ProjectionBackend`.

Live backends must require a valid promotion artifact before writes.

### Rewrite `trade-simulator` into projection liquidity agents

The current name is wrong for the target product.

Rewrite as `projection-liquidity-agent` or remove it from the default runtime.

Rules:

- no user-facing fake PnL claims,
- no promotion credit unless the release gate verifies the run,
- no live-equivalent ranking,
- no hardcoded strategy that only exists to animate books.

### Rewrite external market ingestion as belief-prior intake

Do not mirror Polymarket markets as Automakit markets.

Create a belief-prior intake lane:

- source adapter: Polymarket, Kalshi, odds feeds, RSS/news, social,
- normalized record: `belief_priors`,
- linked external market metadata: `external_market_refs`,
- current price/probability snapshots: `belief_prior_snapshots`,
- provenance and freshness metadata.

These priors feed scenarios and release-gate cases. They do not create tradable markets by themselves.

### Rewrite UI around gate runs, not fake markets

Primary views should become:

- agent versions,
- gate runs,
- verifier results,
- promotion artifacts,
- risk scopes,
- live adapter status,
- replay traces.

Market views can still exist, but they are context for execution tests rather than the product center.

### Rewrite tests around promotion guarantees

The critical tests should prove:

- projection and live states are separated,
- live writes fail closed without a promotion artifact,
- artifact scopes are enforced,
- expired artifacts fail,
- risk limits are enforced before live submission,
- projection success does not imply live permission,
- verifier failure prevents promotion.

## 8. What To Build Next

### PR 1: Belief Prior Intake

Goal: use Polymarket and similar sources without becoming a clone.

Deliverables:

- persistence tables:
  - `belief_sources`
  - `external_market_refs`
  - `belief_prior_snapshots`
- service or `world-input` adapter for Polymarket public market data,
- normalized probability/liquidity/freshness fields,
- provenance fields,
- no market publication from priors alone.

Pass condition:

- a Polymarket market can be ingested as a belief prior,
- it appears as scenario input,
- it cannot create a tradable Automakit market without proposal and approval flow.

### PR 2: Execution Backend Boundary

Goal: make projection and live execution explicit.

Deliverables:

- `ExecutionBackend` interface,
- `ProjectionBackend` wrapping existing matching-engine and portfolio flow,
- disabled `LiveBackend` stub,
- execution mode field on gateway requests or resolved agent context,
- clear backend labels in responses and ledgers.

Pass condition:

- current projection behavior still works,
- live mode cannot submit orders yet,
- attempting live mode without a valid artifact fails closed.

### PR 3: Promotion Artifact Enforcement

Goal: enforce the release-gate promise at write time.

Deliverables:

- artifact lookup in `agent-gateway`,
- scope matching for agent, backend, market type, order type, and notional,
- expiry checks,
- revocation checks,
- audit event for every denied live write.

Pass condition:

- live write without artifact is rejected,
- live write with wrong scope is rejected,
- live write with expired artifact is rejected,
- projection writes do not accidentally consume live scope.

### PR 4: Projection Run Verifier Upgrade

Goal: make projection runs useful as promotion evidence.

Deliverables:

- hidden scenario suites,
- stale data scenarios,
- partial fill scenarios,
- cancel race scenarios,
- resolution and payout scenarios,
- risk-limit violation scenarios,
- deterministic verifier report format.

Pass condition:

- verifier can fail an agent for unsafe behavior even if projection PnL is positive.

### PR 5: UI And Docs Cutover

Goal: stop presenting the product as a mock market.

Deliverables:

- default UI entry is gate runs and promotion artifacts,
- projection market views are secondary evidence pages,
- README and PRD use release-gate language only,
- "paper trading" language removed except when explicitly describing a non-product test mode.

Pass condition:

- a new user understands Automakit as release gating for market-facing agents, not a fake exchange.

## 9. Keep, But Reframe

### Keep simulation

CAMEL/Oasis and direct LLM simulation are useful for upstream belief generation and scenario diversity.

They must remain:

- explicitly enabled,
- upstream of proposal generation,
- separate from settlement truth,
- separate from release-gate promotion.

### Keep projection execution

Projection execution is required.

It must remain:

- production-shaped,
- isolated,
- clearly labeled,
- auditable,
- unable to masquerade as live performance.

### Keep market automation

Market automation is useful for generating realistic execution contexts.

It must not become:

- the default runtime,
- a fake public exchange,
- a shortcut around live adapter work.

## 10. Decision Rule

When deciding whether to keep or build a component, ask:

> Does this produce evidence that an agent can safely receive real execution scope?

If yes, keep or rewrite it.

If no, remove it from the default product path.

If it only makes fake markets feel alive, archive it or keep it behind an explicit development profile.
