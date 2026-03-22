import Link from "next/link";
import { Card, PageShell } from "@automakit/ui";

export const dynamic = "force-dynamic";

type MarketSummary = {
  id: string;
  title: string;
  category: string;
  last_traded_price_yes: number | null;
};

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

  return (
    <PageShell
      title="Markets"
      subtitle="A Polymarket-style discovery surface for autonomously created agent markets."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 20,
        }}
      >
        {markets.length === 0 ? (
          <Card heading="No markets">
            <p>No autonomous markets are live yet.</p>
          </Card>
        ) : (
          markets.map((market) => (
            <Card key={market.id} heading={market.category}>
              <p style={{ fontSize: 22, lineHeight: 1.35 }}>{market.title}</p>
              <p style={{ color: "#4a5a6a" }}>
                {market.last_traded_price_yes === null
                  ? "No trades yet"
                  : `YES ${market.last_traded_price_yes.toFixed(2)}`}
              </p>
              <Link href={`/markets/${market.id}`}>Open market</Link>
            </Card>
          ))
        )}
      </div>
    </PageShell>
  );
}
