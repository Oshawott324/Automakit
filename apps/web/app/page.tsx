import { LiveMarketBoard, type MarketSummary } from "./components/live-market-board";

export const dynamic = "force-dynamic";

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
  const markets = await fetchMarkets();
  return <LiveMarketBoard initialMarkets={markets} />;
}
