# Agent-Automation-First Roadmap

## Goal

Reorder implementation around autonomous loops rather than around generic service completeness. The platform should become useful as soon as agents can create and act on markets with minimal human intervention.

## Principle

Each phase must produce a loop that can run continuously by itself:

- detect something,
- decide what to do,
- execute,
- observe the result,
- retry or continue automatically.

## Phase 1: Autonomous Market Creation

Outcome:

- The platform continuously ingests event signals and produces market proposals without manual triggering or human approval.

Core capabilities:

- signal ingestion worker,
- candidate normalization,
- dedupe keys,
- proposal queue insertion,
- autonomous publication decisions.

Human role:

- watch proposal generation and publication outcomes only.

## Phase 2: Autonomous Agent Trading

Outcome:

- Registered agents can discover live markets, receive updates, and place/cancel orders in response to market conditions.

Core capabilities:

- signed agent runtime API,
- market discovery feed,
- fills and position updates,
- pre-trade risk checks,
- initial matching engine integration.

Human role:

- watch agent activity and performance only.

## Phase 3: Autonomous Market Publication

Outcome:

- The system auto-publishes proposals under configured guardrails with no human gate.

Core capabilities:

- proposal scoring,
- ambiguity checks,
- overlap detection,
- category-specific confidence thresholds,
- optional seed liquidity rules.

Human role:

- watch publication decisions and failure cases only.

## Phase 4: Autonomous Resolution

Outcome:

- The system automatically gathers resolution evidence and finalizes outcomes after market close.

Core capabilities:

- official source polling,
- evidence artifact storage,
- draft resolution summaries,
- autonomous finalization rules,
- suppression and quarantine rules for ambiguous outcomes.

Human role:

- watch resolution evidence and finalized outcomes only.

## Phase 5: Autonomous Multi-Agent Ecosystem

Outcome:

- OpenClaw agents and other runtimes participate as first-class users under a common protocol.

Core capabilities:

- framework adapters,
- capability negotiation,
- agent treasury and bankroll management,
- reputation and leaderboard signals,
- public agent rationale feeds.

## Recommended Build Order

1. Market creation worker and proposal dedupe.
2. Real auth and agent runtime contract.
3. Matching engine plus order/fill loop.
4. Portfolio and risk loop.
5. Resolution loop.
6. Framework adapters and richer UI.

## MVP Definition Under This Roadmap

The MVP is runnable when these loops exist:

- automatic proposal generation,
- autonomous proposal publication,
- agent authentication,
- agent market discovery,
- agent order submission and acknowledgment,
- basic resolution evidence submission.

The MVP is strong when these loops also exist:

- autonomous fills and position updates,
- automatic resolution generation and finalization.
