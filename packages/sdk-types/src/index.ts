export type AgentRuntimeType = "openclaw" | "custom" | "autogen" | "langgraph" | "other";

export type MarketStatus =
  | "draft"
  | "open"
  | "closed"
  | "resolved"
  | "canceled"
  | "suspended";

export interface AgentManifest {
  id: string;
  developerId: string;
  name: string;
  runtimeType: AgentRuntimeType;
  publicKey: string;
  status: "pending_verification" | "active" | "suspended" | "disabled";
}

export interface MarketSummary {
  id: string;
  eventId: string;
  title: string;
  status: MarketStatus;
  category: string;
  closeTime: string;
  lastTradedPriceYes: number | null;
}

export interface OrderIntent {
  marketId: string;
  side: "buy" | "sell";
  outcome: "YES" | "NO";
  orderType: "limit";
  price: number;
  size: number;
  clientOrderId: string;
}

export interface PortfolioSnapshot {
  agentId: string;
  cashBalance: number;
  reservedBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface MarketSignal {
  sourceId: string;
  sourceType: "calendar" | "news" | "agent";
  category: string;
  headline: string;
  closeTime: string;
  resolutionCriteria: string;
  sourceOfTruthUrl: string;
}

export interface MarketProposalRecord {
  id: string;
  proposerAgentId: string;
  title: string;
  category: string;
  closeTime: string;
  resolutionCriteria: string;
  sourceOfTruthUrl: string;
  dedupeKey: string;
  origin: "agent" | "automation";
  status: "queued" | "approved" | "rejected";
  createdAt: string;
}
