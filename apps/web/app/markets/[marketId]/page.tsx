import { LiveMarketDetail, type MarketDetail } from "../../components/live-market-detail";

export const dynamic = "force-dynamic";

async function fetchMarket(marketId: string): Promise<MarketDetail | null> {
  const baseUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";

  try {
    const response = await fetch(`${baseUrl}/v1/markets/${marketId}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as MarketDetail;
  } catch {
    return null;
  }
}

export default async function MarketPage({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  const market = await fetchMarket(marketId);
  return <LiveMarketDetail initialMarket={market} marketId={marketId} />;
}
