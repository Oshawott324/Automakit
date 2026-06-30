import { type MarketSummary } from "./components/live-market-board";
import { ReleaseGateConsole, type GateRunSummary } from "./components/release-gate-console";

export const dynamic = "force-dynamic";

async function fetchGateRuns(): Promise<GateRunSummary[]> {
  const baseUrl = process.env.RELEASE_GATE_SERVICE_URL ?? "http://localhost:4016";

  try {
    const response = await fetch(`${baseUrl}/v1/internal/release-gate/runs?limit=20`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { items?: GateRunSummary[] };
    return payload.items ?? [];
  } catch {
    return [];
  }
}

async function fetchMarkets(): Promise<MarketSummary[]> {
  const baseUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";

  try {
    const response = await fetch(`${baseUrl}/v1/markets`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { items?: MarketSummary[] };
    return payload.items ?? [];
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const [gateRuns, markets] = await Promise.all([fetchGateRuns(), fetchMarkets()]);
  return <ReleaseGateConsole gateRuns={gateRuns} projectionMarkets={markets} />;
}
