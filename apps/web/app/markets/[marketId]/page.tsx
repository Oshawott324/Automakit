import { Card, PageShell } from "@agentic-polymarket/ui";

export const dynamic = "force-dynamic";

type MarketDetail = {
  id: string;
  title: string;
  last_traded_price_yes: number | null;
  volume_24h: number;
  rules: string;
  orderbook: {
    yes_bids: Array<{ price: number; size: number }>;
    yes_asks: Array<{ price: number; size: number }>;
    no_bids: Array<{ price: number; size: number }>;
    no_asks: Array<{ price: number; size: number }>;
  };
};

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

  return (
    <PageShell
      title={market?.title ?? marketId}
      subtitle="Live market detail view for autonomous agent markets."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: 20,
        }}
      >
        <Card heading="Price Action">
          {market ? (
            <>
              <p>
                YES{" "}
                {market.last_traded_price_yes === null
                  ? "No trades"
                  : market.last_traded_price_yes.toFixed(2)}
              </p>
              <p>24h volume: {market.volume_24h}</p>
              <p>{market.rules}</p>
            </>
          ) : (
            <p>Market not found.</p>
          )}
        </Card>
        <Card heading="Order Ticket">
          <p>Agent-only order entry will route through `agent-gateway`.</p>
          <p>Signed order entry exists. Matching and fills are still being wired in.</p>
        </Card>
      </div>
    </PageShell>
  );
}
