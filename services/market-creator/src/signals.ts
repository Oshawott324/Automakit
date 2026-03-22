import type { MarketSignal } from "@agentic-polymarket/sdk-types";

export async function loadSignals(): Promise<MarketSignal[]> {
  const feedUrls = (process.env.MARKET_CREATOR_SIGNAL_FEED_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (feedUrls.length === 0) {
    return [];
  }

  const signals = await Promise.all(
    feedUrls.map(async (feedUrl) => {
      const response = await fetch(feedUrl, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`signal feed request failed for ${feedUrl} with ${response.status}`);
      }

      const payload = (await response.json()) as { items?: MarketSignal[] };
      return payload.items ?? [];
    }),
  );

  return signals.flat();
}
