import Link from "next/link";
import type { MarketSummary } from "./live-market-board";

export type PromotionArtifactSummary = {
  id: string;
  artifact_key: string | null;
  artifact_kind: string | null;
  status: string | null;
  issued_at: string | null;
  expires_at: string | null;
};

export type GateRunSummary = {
  id: string;
  run_key: string;
  snapshot_id: string;
  projection_run_id: string | null;
  status: "created" | "running" | "passed" | "failed";
  decision: "not_run" | "passed" | "failed";
  failure_reason: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  snapshot: {
    id: string;
    snapshot_key: string;
    gate_name: string;
    gate_version: string;
    candidate_kind: string;
    candidate_id: string;
    candidate_version: string;
    projection_runtime: string;
    semantic_facade_version: string;
  };
  promotion_artifact: PromotionArtifactSummary | null;
};

function formatDateTime(value: string | null) {
  if (!value) {
    return "Not completed";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCents(value: number | null) {
  if (value === null) {
    return "--";
  }
  return `${Math.round(value * 100)}c`;
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function artifactLabel(artifact: PromotionArtifactSummary | null) {
  if (!artifact) {
    return "none";
  }
  return artifact.status ?? "unknown";
}

export function ReleaseGateConsole({
  gateRuns,
  projectionMarkets,
}: {
  gateRuns: GateRunSummary[];
  projectionMarkets: MarketSummary[];
}) {
  const activeRuns = gateRuns.filter((run) => run.status === "created" || run.status === "running").length;
  const passedRuns = gateRuns.filter((run) => run.decision === "passed").length;
  const issuedArtifacts = gateRuns.filter((run) => run.promotion_artifact?.status === "issued").length;
  const secondaryMarkets = projectionMarkets.slice(0, 6);

  return (
    <main className="rg-root">
      <div className="rg-shell">
        <header className="rg-topbar">
          <Link href="/" className="rg-brand">
            <span className="rg-brand-mark">A</span>
            <span>Automakit</span>
          </Link>
          <nav className="rg-nav" aria-label="Primary">
            <Link className="active" href="/">
              Release Gates
            </Link>
            <a href="#execution-path-title">Live Path</a>
            <a href="#projection-context-title">Projection Context</a>
          </nav>
        </header>

        <section className="rg-hero">
          <div>
            <p className="rg-eyebrow">Market-facing agent release control</p>
            <h1>Release Gate Console</h1>
            <p className="rg-subtitle">
              Verify agent versions against production-shaped projection runs before granting scoped live execution.
            </p>
          </div>
          <div className="rg-stat-grid" aria-label="Release gate summary">
            <div>
              <span>Recent Runs</span>
              <strong>{gateRuns.length}</strong>
            </div>
            <div>
              <span>Active</span>
              <strong>{activeRuns}</strong>
            </div>
            <div>
              <span>Passed</span>
              <strong>{passedRuns}</strong>
            </div>
            <div>
              <span>Issued Artifacts</span>
              <strong>{issuedArtifacts}</strong>
            </div>
          </div>
        </section>

        <section className="rg-panel rg-run-panel" aria-labelledby="gate-runs-title">
          <div className="rg-section-head">
            <div>
              <p className="rg-eyebrow">Verifier decisions</p>
              <h2 id="gate-runs-title">Recent Gate Runs</h2>
            </div>
            <span className="rg-live-rule">No promotion artifact, no live write</span>
          </div>

          {gateRuns.length === 0 ? (
            <div className="rg-empty">
              <h3>No release gate runs recorded</h3>
              <p>Create a gate run through the release-gate service to evaluate an agent version.</p>
            </div>
          ) : (
            <div className="rg-run-list">
              {gateRuns.map((run) => (
                <article key={run.id} className="rg-run-card">
                  <div className="rg-run-main">
                    <div className="rg-run-title-row">
                      <h3>{run.snapshot.candidate_id}</h3>
                      <span className={`rg-pill rg-status-${run.status}`}>{statusLabel(run.status)}</span>
                      <span className={`rg-pill rg-decision-${run.decision}`}>{statusLabel(run.decision)}</span>
                    </div>
                    <div className="rg-run-meta">
                      <span>{run.snapshot.candidate_kind}</span>
                      <span>version {run.snapshot.candidate_version}</span>
                      <span>{run.snapshot.gate_name}@{run.snapshot.gate_version}</span>
                    </div>
                    {run.failure_reason ? <p className="rg-failure">{run.failure_reason}</p> : null}
                  </div>

                  <dl className="rg-run-facts">
                    <div>
                      <dt>Facade</dt>
                      <dd>{run.snapshot.semantic_facade_version}</dd>
                    </div>
                    <div>
                      <dt>Projection Runtime</dt>
                      <dd>{run.snapshot.projection_runtime}</dd>
                    </div>
                    <div>
                      <dt>Started</dt>
                      <dd>{formatDateTime(run.started_at)} UTC</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{formatDateTime(run.updated_at)} UTC</dd>
                    </div>
                    <div>
                      <dt>Promotion Artifact</dt>
                      <dd className={`rg-artifact rg-artifact-${artifactLabel(run.promotion_artifact)}`}>
                        {artifactLabel(run.promotion_artifact)}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rg-secondary-grid">
          <section className="rg-panel" aria-labelledby="execution-path-title">
            <div className="rg-section-head">
              <div>
                <p className="rg-eyebrow">Execution path</p>
                <h2 id="execution-path-title">Backend Boundary</h2>
              </div>
            </div>
            <ol className="rg-path-list">
              <li>
                <strong>Projection</strong>
                <span>Production-shaped order, fill, cancel, and portfolio semantics.</span>
              </li>
              <li>
                <strong>Verifier</strong>
                <span>Tool coverage, state hashes, ledger invariants, and risk-denial evidence.</span>
              </li>
              <li>
                <strong>Promotion</strong>
                <span>Scoped artifact with expiry, approved execution mode, and risk limits.</span>
              </li>
              <li>
                <strong>Live Adapter</strong>
                <span>Closed to writes unless the artifact authorizes the exact request.</span>
              </li>
            </ol>
          </section>

          <section className="rg-panel" aria-labelledby="projection-context-title">
            <div className="rg-section-head">
              <div>
                <p className="rg-eyebrow">Secondary context</p>
                <h2 id="projection-context-title">Projection Markets</h2>
              </div>
            </div>
            {secondaryMarkets.length === 0 ? (
              <div className="rg-empty compact">
                <h3>No projection markets loaded</h3>
                <p>Market context is optional; gate evidence is the product center.</p>
              </div>
            ) : (
              <div className="rg-market-context">
                {secondaryMarkets.map((market) => (
                  <Link key={market.id} className="rg-market-row" href={`/markets/${market.id}`}>
                    <span>
                      <strong>{market.title}</strong>
                      <em>{market.category} · {market.status}</em>
                    </span>
                    <span>
                      <strong>{formatCents(market.last_traded_price_yes)}</strong>
                      <em>vol {formatCompactNumber(market.volume_24h)}</em>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}
