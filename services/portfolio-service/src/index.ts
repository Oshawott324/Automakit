import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { PoolClient } from "pg";
import { createDatabasePool, ensureCoreSchema, toIsoTimestamp } from "@automakit/persistence";

type Outcome = "YES" | "NO";
type Side = "buy" | "sell";

type AccountRow = {
  agent_id: string;
  cash_balance: unknown;
  reserved_cash: unknown;
  realized_pnl: unknown;
  unsettled_pnl: unknown;
  fees: unknown;
  payouts: unknown;
  updated_at: unknown;
};

type PositionRow = {
  agent_id: string;
  market_id: string;
  outcome: Outcome;
  market_category: string;
  quantity: unknown;
  reserved_quantity: unknown;
  cost_basis_notional: unknown;
  updated_at: unknown;
};

type RiskLimitRow = {
  agent_id: string;
  max_order_size: unknown;
  max_market_exposure: unknown;
  max_category_exposure: unknown;
  allow_shorting: boolean;
  cancel_on_disconnect: boolean;
  updated_at: unknown;
};

type MarketContextRow = {
  id: string;
  category: string;
  last_traded_price_yes: unknown;
};

type ResolutionRow = {
  market_id: string;
  final_outcome: "YES" | "NO" | "CANCELED" | null;
};

type Queryable = Pick<PoolClient, "query">;

const port = Number(process.env.PORTFOLIO_SERVICE_PORT ?? 4004);
const defaultCashBalance = Number(process.env.AGENT_DEFAULT_CASH_BALANCE ?? 100000);
const defaultMaxOrderSize = Number(process.env.RISK_MAX_ORDER_SIZE ?? 1000);
const defaultMaxMarketExposure = Number(process.env.RISK_MAX_MARKET_EXPOSURE ?? 25000);
const defaultMaxCategoryExposure = Number(process.env.RISK_MAX_CATEGORY_EXPOSURE ?? 50000);
const feeRate = Number(process.env.TRADE_FEE_RATE ?? 0);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

async function ensureAccount(client: Queryable, agentId: string) {
  await client.query(
    `
      INSERT INTO portfolio_accounts (
        agent_id,
        cash_balance,
        reserved_cash,
        realized_pnl,
        unsettled_pnl,
        fees,
        payouts,
        updated_at
      )
      VALUES ($1, $2, 0, 0, 0, 0, 0, NOW())
      ON CONFLICT (agent_id) DO NOTHING
    `,
    [agentId, defaultCashBalance],
  );
}

async function ensureRiskLimits(client: Queryable, agentId: string) {
  await client.query(
    `
      INSERT INTO agent_risk_limits (
        agent_id,
        max_order_size,
        max_market_exposure,
        max_category_exposure,
        allow_shorting,
        cancel_on_disconnect,
        updated_at
      )
      VALUES ($1, $2, $3, $4, false, false, NOW())
      ON CONFLICT (agent_id) DO NOTHING
    `,
    [agentId, defaultMaxOrderSize, defaultMaxMarketExposure, defaultMaxCategoryExposure],
  );
}

async function ensurePosition(client: Queryable, agentId: string, marketId: string, outcome: Outcome, category: string) {
  await client.query(
    `
      INSERT INTO portfolio_positions (
        agent_id,
        market_id,
        outcome,
        market_category,
        quantity,
        reserved_quantity,
        cost_basis_notional,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 0, 0, 0, NOW())
      ON CONFLICT (agent_id, market_id, outcome) DO NOTHING
    `,
    [agentId, marketId, outcome, category],
  );
}

async function getAccount(client: Queryable, agentId: string) {
  await ensureAccount(client, agentId);
  const result = await client.query<AccountRow>(
    `
      SELECT *
      FROM portfolio_accounts
      WHERE agent_id = $1
    `,
    [agentId],
  );
  return result.rows[0];
}

async function getRiskLimits(client: Queryable, agentId: string) {
  await ensureRiskLimits(client, agentId);
  const result = await client.query<RiskLimitRow>(
    `
      SELECT *
      FROM agent_risk_limits
      WHERE agent_id = $1
    `,
    [agentId],
  );
  return result.rows[0];
}

async function getMarketContext(client: Queryable, marketId: string) {
  const result = await client.query<MarketContextRow>(
    `
      SELECT id, category, last_traded_price_yes
      FROM markets
      WHERE id = $1
    `,
    [marketId],
  );
  return result.rowCount ? result.rows[0] : null;
}

async function getPosition(client: Queryable, agentId: string, marketId: string, outcome: Outcome, category: string) {
  await ensurePosition(client, agentId, marketId, outcome, category);
  const result = await client.query<PositionRow>(
    `
      SELECT *
      FROM portfolio_positions
      WHERE agent_id = $1 AND market_id = $2 AND outcome = $3
    `,
    [agentId, marketId, outcome],
  );
  return result.rows[0];
}

async function updateAccount(
  client: Queryable,
  agentId: string,
  deltas: {
    cash_delta: number;
    reserved_cash_delta: number;
    realized_pnl_delta: number;
    unsettled_pnl_delta: number;
    fees_delta: number;
    payouts_delta: number;
  },
) {
  await client.query(
    `
      UPDATE portfolio_accounts
      SET
        cash_balance = cash_balance + $2,
        reserved_cash = reserved_cash + $3,
        realized_pnl = realized_pnl + $4,
        unsettled_pnl = unsettled_pnl + $5,
        fees = fees + $6,
        payouts = payouts + $7,
        updated_at = NOW()
      WHERE agent_id = $1
    `,
    [
      agentId,
      deltas.cash_delta,
      deltas.reserved_cash_delta,
      deltas.realized_pnl_delta,
      deltas.unsettled_pnl_delta,
      deltas.fees_delta,
      deltas.payouts_delta,
    ],
  );
}

async function updatePosition(
  client: Queryable,
  agentId: string,
  marketId: string,
  outcome: Outcome,
  category: string,
  deltas: {
    position_delta: number;
    reserved_position_delta: number;
    cost_basis_notional_delta: number;
  },
) {
  await ensurePosition(client, agentId, marketId, outcome, category);
  await client.query(
    `
      UPDATE portfolio_positions
      SET
        quantity = quantity + $5,
        reserved_quantity = reserved_quantity + $6,
        cost_basis_notional = cost_basis_notional + $7,
        updated_at = NOW()
      WHERE agent_id = $1
        AND market_id = $2
        AND outcome = $3
        AND market_category = $4
    `,
    [
      agentId,
      marketId,
      outcome,
      category,
      deltas.position_delta,
      deltas.reserved_position_delta,
      deltas.cost_basis_notional_delta,
    ],
  );
}

async function insertLedgerEntry(
  client: Queryable,
  entry: {
    agent_id: string;
    market_id?: string | null;
    outcome?: Outcome | null;
    entry_type: string;
    cash_delta?: number;
    reserved_cash_delta?: number;
    position_delta?: number;
    reserved_position_delta?: number;
    cost_basis_notional_delta?: number;
    realized_pnl_delta?: number;
    unsettled_pnl_delta?: number;
    fees_delta?: number;
    payouts_delta?: number;
    reference_type: string;
    reference_id: string;
    metadata?: unknown;
    created_at?: string;
  },
) {
  await client.query(
    `
      INSERT INTO portfolio_ledger_entries (
        id,
        agent_id,
        market_id,
        outcome,
        entry_type,
        cash_delta,
        reserved_cash_delta,
        position_delta,
        reserved_position_delta,
        cost_basis_notional_delta,
        realized_pnl_delta,
        unsettled_pnl_delta,
        fees_delta,
        payouts_delta,
        reference_type,
        reference_id,
        metadata,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17::jsonb, $18::timestamptz
      )
      ON CONFLICT (reference_type, reference_id, agent_id) DO NOTHING
    `,
    [
      randomUUID(),
      entry.agent_id,
      entry.market_id ?? null,
      entry.outcome ?? null,
      entry.entry_type,
      entry.cash_delta ?? 0,
      entry.reserved_cash_delta ?? 0,
      entry.position_delta ?? 0,
      entry.reserved_position_delta ?? 0,
      entry.cost_basis_notional_delta ?? 0,
      entry.realized_pnl_delta ?? 0,
      entry.unsettled_pnl_delta ?? 0,
      entry.fees_delta ?? 0,
      entry.payouts_delta ?? 0,
      entry.reference_type,
      entry.reference_id,
      JSON.stringify(entry.metadata ?? {}),
      entry.created_at ?? new Date().toISOString(),
    ],
  );
}

async function computeUnsettledPnl(client: Queryable, agentId: string) {
  const positionsResult = await client.query<PositionRow & { last_traded_price_yes: unknown; final_outcome: string | null }>(
    `
      SELECT
        p.*,
        m.last_traded_price_yes,
        rc.final_outcome
      FROM portfolio_positions p
      JOIN markets m ON m.id = p.market_id
      LEFT JOIN resolution_cases rc ON rc.market_id = p.market_id
      WHERE p.agent_id = $1
        AND p.quantity > 0
    `,
    [agentId],
  );

  let total = 0;
  const positions = positionsResult.rows.map((row) => {
    const quantity = toNumber(row.quantity);
    const costBasisNotional = toNumber(row.cost_basis_notional);
    const averagePrice = quantity > 0 ? costBasisNotional / quantity : 0;

    let markPriceYes = toNumber(row.last_traded_price_yes);
    if (row.final_outcome === "YES") {
      markPriceYes = 1;
    } else if (row.final_outcome === "NO") {
      markPriceYes = 0;
    }
    const markPrice = row.outcome === "YES" ? markPriceYes : 1 - markPriceYes;
    const unrealized = quantity * (markPrice - averagePrice);
    total += unrealized;

    return {
      market_id: row.market_id,
      outcome: row.outcome,
      quantity,
      reserved_quantity: toNumber(row.reserved_quantity),
      average_price: averagePrice,
      mark_price: markPrice,
      unrealized_pnl: unrealized,
    };
  });

  await client.query(
    `
      UPDATE portfolio_accounts
      SET unsettled_pnl = $2, updated_at = NOW()
      WHERE agent_id = $1
    `,
    [agentId, total],
  );

  return { unsettledPnl: total, positions };
}

async function getPortfolioSnapshot(client: Queryable, agentId: string) {
  const account = await getAccount(client, agentId);
  const { unsettledPnl, positions } = await computeUnsettledPnl(client, agentId);

  return {
    agent_id: agentId,
    cash_balance: toNumber(account.cash_balance),
    reserved_balance: toNumber(account.reserved_cash),
    realized_pnl: toNumber(account.realized_pnl),
    unrealized_pnl: unsettledPnl,
    fees: toNumber(account.fees),
    payouts: toNumber(account.payouts),
    positions,
  };
}

async function getCategoryExposure(client: Queryable, agentId: string, category: string) {
  const result = await client.query<{ exposure: unknown }>(
    `
      SELECT COALESCE(SUM(cost_basis_notional + reserved_quantity), 0) AS exposure
      FROM portfolio_positions
      WHERE agent_id = $1
        AND market_category = $2
    `,
    [agentId, category],
  );
  return toNumber(result.rows[0]?.exposure);
}

async function getMarketExposure(client: Queryable, agentId: string, marketId: string) {
  const result = await client.query<{ exposure: unknown }>(
    `
      SELECT COALESCE(SUM(cost_basis_notional + reserved_quantity), 0) AS exposure
      FROM portfolio_positions
      WHERE agent_id = $1
        AND market_id = $2
    `,
    [agentId, marketId],
  );
  return toNumber(result.rows[0]?.exposure);
}

app.get("/health", async () => ({ service: "portfolio-service", status: "ok" }));

app.get("/v1/internal/portfolios/:agentId", async (request) => {
  const agentId = (request.params as { agentId: string }).agentId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshot = await getPortfolioSnapshot(client, agentId);
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/internal/orders/reserve", async (request, reply) => {
  const body = request.body as {
    order_id?: string;
    agent_id?: string;
    market_id?: string;
    side?: Side;
    outcome?: Outcome;
    price?: number;
    size?: number;
  };

  if (
    !body.order_id ||
    !body.agent_id ||
    !body.market_id ||
    !body.side ||
    !body.outcome ||
    typeof body.price !== "number" ||
    typeof body.size !== "number"
  ) {
    reply.code(400);
    return { error: "invalid_reserve_request" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const market = await getMarketContext(client, body.market_id);
    if (!market) {
      reply.code(404);
      return { error: "market_not_found" };
    }

    const account = await getAccount(client, body.agent_id);
    const limits = await getRiskLimits(client, body.agent_id);

    if (body.size > toNumber(limits.max_order_size)) {
      reply.code(422);
      return { error: "max_order_size_exceeded" };
    }

    const marketExposure = await getMarketExposure(client, body.agent_id, body.market_id);
    const categoryExposure = await getCategoryExposure(client, body.agent_id, market.category);
    const proposedExposure = body.price * body.size;
    if (marketExposure + proposedExposure > toNumber(limits.max_market_exposure)) {
      reply.code(422);
      return { error: "max_market_exposure_exceeded" };
    }
    if (categoryExposure + proposedExposure > toNumber(limits.max_category_exposure)) {
      reply.code(422);
      return { error: "max_category_exposure_exceeded" };
    }

    if (body.side === "buy") {
      const availableCash = toNumber(account.cash_balance) - toNumber(account.reserved_cash);
      const requiredCash = body.price * body.size;
      if (availableCash + 1e-9 < requiredCash) {
        reply.code(422);
        return { error: "insufficient_cash" };
      }

      await updateAccount(client, body.agent_id, {
        cash_delta: 0,
        reserved_cash_delta: requiredCash,
        realized_pnl_delta: 0,
        unsettled_pnl_delta: 0,
        fees_delta: 0,
        payouts_delta: 0,
      });
      await insertLedgerEntry(client, {
        agent_id: body.agent_id,
        market_id: body.market_id,
        outcome: body.outcome,
        entry_type: "reserve_cash",
        reserved_cash_delta: requiredCash,
        reference_type: "order_reserve",
        reference_id: body.order_id,
        metadata: { side: body.side, price: body.price, size: body.size },
      });
    } else {
      const position = await getPosition(client, body.agent_id, body.market_id, body.outcome, market.category);
      const availableQuantity = toNumber(position.quantity) - toNumber(position.reserved_quantity);
      if (!limits.allow_shorting && availableQuantity + 1e-9 < body.size) {
        reply.code(422);
        return { error: "insufficient_inventory" };
      }

      await updatePosition(client, body.agent_id, body.market_id, body.outcome, market.category, {
        position_delta: 0,
        reserved_position_delta: body.size,
        cost_basis_notional_delta: 0,
      });
      await insertLedgerEntry(client, {
        agent_id: body.agent_id,
        market_id: body.market_id,
        outcome: body.outcome,
        entry_type: "reserve_position",
        reserved_position_delta: body.size,
        reference_type: "order_reserve",
        reference_id: body.order_id,
        metadata: { side: body.side, price: body.price, size: body.size },
      });
    }

    const snapshot = await getPortfolioSnapshot(client, body.agent_id);
    await client.query("COMMIT");
    return {
      status: "approved",
      portfolio: snapshot,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/internal/orders/settle", async (request) => {
  const body = request.body as {
    fills?: Array<{
      fill_id: string;
      market_id: string;
      outcome: Outcome;
      price: number;
      size: number;
      buy_order_id: string;
      sell_order_id: string;
      buy_agent_id: string;
      sell_agent_id: string;
      buy_limit_price: number;
      sell_limit_price: number;
      executed_at: string;
    }>;
  };

  const fills = body.fills ?? [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const fill of fills) {
      const market = await getMarketContext(client, fill.market_id);
      if (!market) {
        continue;
      }

      const buyFee = fill.price * fill.size * feeRate;
      await ensureAccount(client, fill.buy_agent_id);
      await updateAccount(client, fill.buy_agent_id, {
        cash_delta: -(fill.price * fill.size + buyFee),
        reserved_cash_delta: -(fill.buy_limit_price * fill.size),
        realized_pnl_delta: 0,
        unsettled_pnl_delta: 0,
        fees_delta: buyFee,
        payouts_delta: 0,
      });
      await updatePosition(client, fill.buy_agent_id, fill.market_id, fill.outcome, market.category, {
        position_delta: fill.size,
        reserved_position_delta: 0,
        cost_basis_notional_delta: fill.price * fill.size + buyFee,
      });
      await insertLedgerEntry(client, {
        agent_id: fill.buy_agent_id,
        market_id: fill.market_id,
        outcome: fill.outcome,
        entry_type: "fill_buy",
        cash_delta: -(fill.price * fill.size + buyFee),
        reserved_cash_delta: -(fill.buy_limit_price * fill.size),
        position_delta: fill.size,
        cost_basis_notional_delta: fill.price * fill.size + buyFee,
        fees_delta: buyFee,
        reference_type: "fill",
        reference_id: fill.fill_id,
        metadata: fill,
        created_at: fill.executed_at,
      });

      const sellerPosition = await getPosition(client, fill.sell_agent_id, fill.market_id, fill.outcome, market.category);
      const sellerQuantity = toNumber(sellerPosition.quantity);
      const averageCost = sellerQuantity > 0 ? toNumber(sellerPosition.cost_basis_notional) / sellerQuantity : 0;
      const sellerFee = fill.price * fill.size * feeRate;
      const realized = fill.price * fill.size - sellerFee - averageCost * fill.size;

      await ensureAccount(client, fill.sell_agent_id);
      await updateAccount(client, fill.sell_agent_id, {
        cash_delta: fill.price * fill.size - sellerFee,
        reserved_cash_delta: 0,
        realized_pnl_delta: realized,
        unsettled_pnl_delta: 0,
        fees_delta: sellerFee,
        payouts_delta: 0,
      });
      await updatePosition(client, fill.sell_agent_id, fill.market_id, fill.outcome, market.category, {
        position_delta: -fill.size,
        reserved_position_delta: -fill.size,
        cost_basis_notional_delta: -(averageCost * fill.size),
      });
      await insertLedgerEntry(client, {
        agent_id: fill.sell_agent_id,
        market_id: fill.market_id,
        outcome: fill.outcome,
        entry_type: "fill_sell",
        cash_delta: fill.price * fill.size - sellerFee,
        position_delta: -fill.size,
        reserved_position_delta: -fill.size,
        cost_basis_notional_delta: -(averageCost * fill.size),
        realized_pnl_delta: realized,
        fees_delta: sellerFee,
        reference_type: "fill",
        reference_id: fill.fill_id,
        metadata: fill,
        created_at: fill.executed_at,
      });
    }

    await client.query("COMMIT");
    return { status: "applied", fill_count: fills.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/internal/orders/cancel", async (request, reply) => {
  const body = request.body as {
    order_id?: string;
    agent_id?: string;
    market_id?: string;
    outcome?: Outcome;
    side?: Side;
    price?: number;
    remaining_size?: number;
  };

  if (
    !body.order_id ||
    !body.agent_id ||
    !body.market_id ||
    !body.outcome ||
    !body.side ||
    typeof body.price !== "number" ||
    typeof body.remaining_size !== "number"
  ) {
    reply.code(400);
    return { error: "invalid_cancel_request" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const market = await getMarketContext(client, body.market_id);
    if (!market) {
      reply.code(404);
      return { error: "market_not_found" };
    }

    if (body.side === "buy") {
      const reservedRelease = body.price * body.remaining_size;
      await ensureAccount(client, body.agent_id);
      await updateAccount(client, body.agent_id, {
        cash_delta: 0,
        reserved_cash_delta: -reservedRelease,
        realized_pnl_delta: 0,
        unsettled_pnl_delta: 0,
        fees_delta: 0,
        payouts_delta: 0,
      });
      await insertLedgerEntry(client, {
        agent_id: body.agent_id,
        market_id: body.market_id,
        outcome: body.outcome,
        entry_type: "cancel_release_cash",
        reserved_cash_delta: -reservedRelease,
        reference_type: "order_cancel",
        reference_id: body.order_id,
        metadata: body,
      });
    } else {
      await updatePosition(client, body.agent_id, body.market_id, body.outcome, market.category, {
        position_delta: 0,
        reserved_position_delta: -body.remaining_size,
        cost_basis_notional_delta: 0,
      });
      await insertLedgerEntry(client, {
        agent_id: body.agent_id,
        market_id: body.market_id,
        outcome: body.outcome,
        entry_type: "cancel_release_position",
        reserved_position_delta: -body.remaining_size,
        reference_type: "order_cancel",
        reference_id: body.order_id,
        metadata: body,
      });
    }

    const snapshot = await getPortfolioSnapshot(client, body.agent_id);
    await client.query("COMMIT");
    return { status: "applied", portfolio: snapshot };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/internal/resolutions/payout", async (request, reply) => {
  const body = request.body as { market_id?: string; final_outcome?: "YES" | "NO" };
  if (!body.market_id || !body.final_outcome) {
    reply.code(400);
    return { error: "invalid_resolution_payout_request" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const market = await getMarketContext(client, body.market_id);
    if (!market) {
      reply.code(404);
      return { error: "market_not_found" };
    }

    const positions = await client.query<PositionRow>(
      `
        SELECT *
        FROM portfolio_positions
        WHERE market_id = $1
          AND quantity > 0
      `,
      [body.market_id],
    );

    for (const position of positions.rows) {
      const quantity = toNumber(position.quantity);
      const costBasis = toNumber(position.cost_basis_notional);
      const payout = position.outcome === body.final_outcome ? quantity : 0;
      const realized = payout - costBasis;
      const referenceId = `${body.market_id}:${position.outcome}`;

      const duplicate = await client.query(
        `
          SELECT 1
          FROM portfolio_ledger_entries
          WHERE agent_id = $1
            AND reference_type = 'resolution_payout'
            AND reference_id = $2
          LIMIT 1
        `,
        [position.agent_id, referenceId],
      );
      if (duplicate.rowCount) {
        continue;
      }

      await ensureAccount(client, position.agent_id);
      await updateAccount(client, position.agent_id, {
        cash_delta: payout,
        reserved_cash_delta: 0,
        realized_pnl_delta: realized,
        unsettled_pnl_delta: 0,
        fees_delta: 0,
        payouts_delta: payout,
      });
      await updatePosition(client, position.agent_id, body.market_id, position.outcome, market.category, {
        position_delta: -quantity,
        reserved_position_delta: -toNumber(position.reserved_quantity),
        cost_basis_notional_delta: -costBasis,
      });
      await insertLedgerEntry(client, {
        agent_id: position.agent_id,
        market_id: body.market_id,
        outcome: position.outcome,
        entry_type: "resolution_payout",
        cash_delta: payout,
        position_delta: -quantity,
        reserved_position_delta: -toNumber(position.reserved_quantity),
        cost_basis_notional_delta: -costBasis,
        realized_pnl_delta: realized,
        payouts_delta: payout,
        reference_type: "resolution_payout",
        reference_id: referenceId,
        metadata: { final_outcome: body.final_outcome },
      });
    }

    await client.query("COMMIT");
    return { status: "applied" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/internal/markets/mint-complete-set", async (request, reply) => {
  const body = request.body as { agent_id?: string; market_id?: string; size?: number };
  if (!body.agent_id || !body.market_id || typeof body.size !== "number" || body.size <= 0) {
    reply.code(400);
    return { error: "invalid_complete_set_mint_request" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const market = await getMarketContext(client, body.market_id);
    if (!market) {
      reply.code(404);
      return { error: "market_not_found" };
    }

    const account = await getAccount(client, body.agent_id);
    const availableCash = toNumber(account.cash_balance) - toNumber(account.reserved_cash);
    if (availableCash + 1e-9 < body.size) {
      reply.code(422);
      return { error: "insufficient_cash_for_complete_set" };
    }

    await updateAccount(client, body.agent_id, {
      cash_delta: -body.size,
      reserved_cash_delta: 0,
      realized_pnl_delta: 0,
      unsettled_pnl_delta: 0,
      fees_delta: 0,
      payouts_delta: 0,
    });

    for (const outcome of ["YES", "NO"] as const) {
      await updatePosition(client, body.agent_id, body.market_id, outcome, market.category, {
        position_delta: body.size,
        reserved_position_delta: 0,
        cost_basis_notional_delta: body.size / 2,
      });
      await insertLedgerEntry(client, {
        agent_id: body.agent_id,
        market_id: body.market_id,
        outcome,
        entry_type: "mint_complete_set",
        cash_delta: 0,
        position_delta: body.size,
        cost_basis_notional_delta: body.size / 2,
        reference_type: "complete_set_mint",
        reference_id: `${body.market_id}:${outcome}:${body.size}:${Date.now()}`,
        metadata: { size: body.size },
      });
    }

    const snapshot = await getPortfolioSnapshot(client, body.agent_id);
    await client.query("COMMIT");
    return { status: "applied", portfolio: snapshot };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
