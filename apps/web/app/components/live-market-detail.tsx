"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type Orderbook = {
  yes_bids: Array<{ price: number; size: number }>;
  yes_asks: Array<{ price: number; size: number }>;
  no_bids: Array<{ price: number; size: number }>;
  no_asks: Array<{ price: number; size: number }>;
};

export type MarketDetail = {
  id: string;
  title: string;
  last_traded_price_yes: number | null;
  volume_24h: number;
  rules: string;
  orderbook: Orderbook;
  close_time: string;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  category: string;
  resolution_source: string;
};

type StreamMessage = {
  type: "snapshot" | "event";
  channel: "market.snapshot" | "orderbook.delta" | "trade.fill" | "resolution.update";
  payload: unknown;
};

function formatPercent(value: number | null) {
  if (value === null) {
    return "--";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatCents(value: number | null) {
  if (value === null) {
    return "--";
  }
  return `${Math.round(value * 100)}¢`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function renderBookRows(side: Array<{ price: number; size: number }>) {
  if (side.length === 0) {
    return (
      <tr>
        <td colSpan={2} className="pm-book-empty">
          No depth
        </td>
      </tr>
    );
  }
  return side.slice(0, 6).map((level) => (
    <tr key={`${level.price}-${level.size}`}>
      <td>{formatPercent(level.price)}</td>
      <td>{formatNumber(level.size)}</td>
    </tr>
  ));
}

export function LiveMarketDetail({
  initialMarket,
  marketId,
}: {
  initialMarket: MarketDetail | null;
  marketId: string;
}) {
  const [market, setMarket] = useState<MarketDetail | null>(initialMarket);
  const [streamState, setStreamState] = useState<"live" | "connecting" | "offline">("connecting");
  const [tradeHistory, setTradeHistory] = useState<number[]>(
    initialMarket?.last_traded_price_yes === null || initialMarket?.last_traded_price_yes === undefined
      ? []
      : [initialMarket.last_traded_price_yes],
  );
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    const wsBase = process.env.NEXT_PUBLIC_STREAM_WS_URL ?? "ws://127.0.0.1:4007/v1/stream/ws";
    const streamToken = process.env.NEXT_PUBLIC_STREAM_TOKEN ?? "";

    const connect = () => {
      if (disposed) {
        return;
      }
      setStreamState("connecting");
      const streamUrl = streamToken
        ? `${wsBase}${wsBase.includes("?") ? "&" : "?"}token=${encodeURIComponent(streamToken)}`
        : wsBase;
      socket = new WebSocket(streamUrl);

      socket.onopen = () => {
        if (!socket) {
          return;
        }
        setStreamState("live");
        socket.send(
          JSON.stringify({
            type: "subscribe",
            channels: ["market.snapshot", "orderbook.delta", "trade.fill", "resolution.update"],
            market_id: marketId,
            snapshot: true,
          }),
        );
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as StreamMessage;
          if (!message || typeof message !== "object") {
            return;
          }

          if (message.channel === "market.snapshot") {
            const payload = Array.isArray(message.payload) ? message.payload[0] : message.payload;
            if (payload && typeof payload === "object" && (payload as { id?: string }).id === marketId) {
              setMarket((current) => ({ ...(current ?? (payload as MarketDetail)), ...(payload as MarketDetail) }));
            }
            return;
          }

          if (message.channel === "orderbook.delta") {
            const payload = Array.isArray(message.payload) ? message.payload[0] : message.payload;
            if (
              payload &&
              typeof payload === "object" &&
              (payload as { market_id?: string }).market_id === marketId
            ) {
              const snapshot = payload as {
                yes_bids: Array<{ price: number; size: number }>;
                yes_asks: Array<{ price: number; size: number }>;
                no_bids: Array<{ price: number; size: number }>;
                no_asks: Array<{ price: number; size: number }>;
              };
              setMarket((current) =>
                current
                  ? {
                      ...current,
                      orderbook: {
                        yes_bids: snapshot.yes_bids ?? [],
                        yes_asks: snapshot.yes_asks ?? [],
                        no_bids: snapshot.no_bids ?? [],
                        no_asks: snapshot.no_asks ?? [],
                      },
                    }
                  : current,
              );
            }
            return;
          }

          if (message.channel === "trade.fill" && message.payload && typeof message.payload === "object") {
            const payload = message.payload as { market_id?: string; price?: number; size?: number; outcome?: string };
            if (payload.market_id !== marketId) {
              return;
            }
            const rawPrice = Number(payload.price);
            const rawSize = Number(payload.size ?? 0);
            if (!Number.isFinite(rawPrice) || !Number.isFinite(rawSize)) {
              return;
            }
            const yesPrice = payload.outcome === "NO" ? 1 - rawPrice : rawPrice;
            setMarket((current) =>
              current
                ? {
                    ...current,
                    last_traded_price_yes: yesPrice,
                    volume_24h: current.volume_24h + rawSize,
                  }
                : current,
            );
            setTradeHistory((current) => [...current, yesPrice].slice(-24));
            return;
          }

          if (message.channel === "resolution.update" && message.payload && typeof message.payload === "object") {
            const payload = message.payload as { market_id?: string; status?: MarketDetail["status"] };
            if (payload.market_id === marketId && typeof payload.status === "string") {
              setMarket((current) => (current ? { ...current, status: payload.status as MarketDetail["status"] } : current));
            }
          }
        } catch {
          // ignore malformed payload
        }
      };

      socket.onerror = () => {
        setStreamState("offline");
      };

      socket.onclose = () => {
        setStreamState("offline");
        if (!disposed) {
          reconnectTimer.current = setTimeout(connect, 1800);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [marketId]);

  const yesPrice = market?.last_traded_price_yes ?? null;
  const noPrice = yesPrice === null ? null : 1 - yesPrice;
  const sparkPoints = useMemo(
    () => (tradeHistory.length > 1 ? tradeHistory : tradeHistory.length === 1 ? [tradeHistory[0], tradeHistory[0]] : []),
    [tradeHistory],
  );

  if (!market) {
    return (
      <main className="pm-root">
        <div className="pm-shell">
          <header className="pm-topbar">
            <div className="pm-brand-wrap">
              <Link href="/" className="pm-brand">
                <span className="pm-brand-mark">A</span>
                <span>Automakit</span>
              </Link>
              <nav className="pm-nav">
                <Link href="/" className="active">
                  Explore
                </Link>
                <Link href="/">Live</Link>
                <Link href="/">Resolved</Link>
              </nav>
            </div>
            <div className="pm-topbar-right">
              <a className="pm-observer-link" href="http://localhost:3001/proposals">
                Observer
              </a>
              <span className="pm-mode-pill">Watch</span>
            </div>
          </header>
          <section className="pm-empty">
            <h1>Market Not Found</h1>
            <p>The selected market id is not available.</p>
            <Link href="/">Back to markets</Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="pm-root">
      <div className="pm-shell">
        <header className="pm-topbar">
          <div className="pm-brand-wrap">
            <Link href="/" className="pm-brand">
              <span className="pm-brand-mark">A</span>
              <span>Automakit</span>
            </Link>
            <nav className="pm-nav">
              <Link href="/" className="active">
                Explore
              </Link>
              <Link href="/">Live</Link>
              <Link href="/">Resolved</Link>
            </nav>
          </div>
          <div className="pm-topbar-right">
            <a className="pm-observer-link" href="http://localhost:3001/proposals">
              Observer
            </a>
            <span className={`pm-mode-pill ${streamState}`}>
              {streamState === "live" ? "Live" : streamState === "connecting" ? "Syncing" : "Offline"}
            </span>
          </div>
        </header>

        <section className="pm-detail-layout">
          <article className="pm-detail-main">
            <p className="pm-detail-bread">
              <Link href="/">Markets</Link>
              <span>/</span>
              <span>{market.category}</span>
            </p>
            <h1>{market.title}</h1>
            <div className="pm-detail-meta">
              <span className={`pm-status ${market.status}`}>{market.status}</span>
              <span>Close {new Date(market.close_time).toUTCString()}</span>
              <span>Volume {formatNumber(market.volume_24h)}</span>
            </div>

            <div className="pm-prob-track large" aria-hidden>
              <span style={{ width: `${yesPrice === null ? 50 : Math.min(95, Math.max(5, yesPrice * 100))}%` }} />
            </div>
            <div className="pm-price-row">
              <div className="pm-quote yes">
                <span>Buy Yes</span>
                <strong>{formatCents(yesPrice)}</strong>
              </div>
              <div className="pm-quote no">
                <span>Buy No</span>
                <strong>{formatCents(noPrice)}</strong>
              </div>
            </div>

            {sparkPoints.length > 1 ? (
              <div className="pm-spark">
                {sparkPoints.map((point, index) => (
                  <span
                    key={`${point}-${index}`}
                    style={{
                      height: `${Math.max(8, Math.min(100, point * 100))}%`,
                    }}
                  />
                ))}
              </div>
            ) : null}

            <p className="pm-rules">{market.rules}</p>
            <p className="pm-source">
              Source:{" "}
              <a href={market.resolution_source} target="_blank" rel="noreferrer">
                {market.resolution_source}
              </a>
            </p>
          </article>

          <aside className="pm-detail-side">
            <article className="pm-ticket">
              <h2>Market Stats</h2>
              <div className="pm-stat-list">
                <div>
                  <span>Category</span>
                  <strong>{market.category}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{market.status}</strong>
                </div>
                <div>
                  <span>Last YES</span>
                  <strong>{formatPercent(yesPrice)}</strong>
                </div>
              </div>
            </article>
            <article className="pm-ticket">
              <h2>Trading</h2>
              <p>All orders are submitted by agents through `agent-gateway`. This page is observer-only.</p>
              <button type="button" disabled>
                Buy YES (Disabled)
              </button>
              <button type="button" disabled>
                Buy NO (Disabled)
              </button>
            </article>
          </aside>
        </section>

        <section className="pm-book-grid">
          <article className="pm-book-card">
            <h3>YES Bids</h3>
            <table>
              <thead>
                <tr>
                  <th>Price</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>{renderBookRows(market.orderbook.yes_bids)}</tbody>
            </table>
          </article>
          <article className="pm-book-card">
            <h3>YES Asks</h3>
            <table>
              <thead>
                <tr>
                  <th>Price</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>{renderBookRows(market.orderbook.yes_asks)}</tbody>
            </table>
          </article>
          <article className="pm-book-card">
            <h3>NO Bids</h3>
            <table>
              <thead>
                <tr>
                  <th>Price</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>{renderBookRows(market.orderbook.no_bids)}</tbody>
            </table>
          </article>
          <article className="pm-book-card">
            <h3>NO Asks</h3>
            <table>
              <thead>
                <tr>
                  <th>Price</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>{renderBookRows(market.orderbook.no_asks)}</tbody>
            </table>
          </article>
        </section>
      </div>
    </main>
  );
}
