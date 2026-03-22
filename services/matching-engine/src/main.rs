use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::Arc,
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Serialize)]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
enum Outcome {
    YES,
    NO,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum OrderStatus {
    Open,
    PartiallyFilled,
    Filled,
    Canceled,
}

#[derive(Clone, Debug, Deserialize)]
struct SubmitOrderRequest {
    order_id: String,
    agent_id: String,
    market_id: String,
    side: Side,
    outcome: Outcome,
    price: f64,
    size: f64,
}

#[derive(Clone, Debug, Deserialize)]
struct CancelOrderRequest {
    order_id: String,
    market_id: String,
    side: Side,
    outcome: Outcome,
}

#[derive(Clone, Debug, Serialize)]
struct OrderUpdate {
    order_id: String,
    filled_size: f64,
    remaining_size: f64,
    status: OrderStatus,
}

#[derive(Clone, Debug, Serialize)]
struct FillExecution {
    fill_id: String,
    market_id: String,
    outcome: Outcome,
    price: f64,
    size: f64,
    buy_order_id: String,
    sell_order_id: String,
    buy_agent_id: String,
    sell_agent_id: String,
    executed_at: String,
}

#[derive(Clone, Debug, Serialize)]
struct SubmitOrderResponse {
    order_id: String,
    status: OrderStatus,
    filled_size: f64,
    remaining_size: f64,
    fills: Vec<FillExecution>,
    touched_orders: Vec<OrderUpdate>,
}

#[derive(Clone, Debug, Serialize)]
struct CancelOrderResponse {
    order_id: String,
    canceled: bool,
}

#[derive(Clone, Debug)]
struct RestingOrder {
    order_id: String,
    agent_id: String,
    price: f64,
    original_size: f64,
    remaining_size: f64,
    sequence: u64,
}

#[derive(Default)]
struct OutcomeBook {
    buy_orders: Vec<RestingOrder>,
    sell_orders: Vec<RestingOrder>,
}

#[derive(Default)]
struct EngineState {
    books: HashMap<String, OutcomeBook>,
    sequence: u64,
}

type SharedState = Arc<Mutex<EngineState>>;

fn book_key(market_id: &str, outcome: Outcome) -> String {
    format!("{market_id}:{outcome:?}")
}

fn order_status(original_size: f64, remaining_size: f64) -> OrderStatus {
    if remaining_size <= f64::EPSILON {
        OrderStatus::Filled
    } else if remaining_size < original_size {
        OrderStatus::PartiallyFilled
    } else {
        OrderStatus::Open
    }
}

fn sort_resting_orders(orders: &mut [RestingOrder], side: Side) {
    match side {
        Side::Buy => orders.sort_by(|left, right| {
            right
                .price
                .partial_cmp(&left.price)
                .unwrap_or(Ordering::Equal)
                .then(left.sequence.cmp(&right.sequence))
        }),
        Side::Sell => orders.sort_by(|left, right| {
            left.price
                .partial_cmp(&right.price)
                .unwrap_or(Ordering::Equal)
                .then(left.sequence.cmp(&right.sequence))
        }),
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        service: "matching-engine",
        status: "ok",
    })
}

async fn submit_order(
    State(state): State<SharedState>,
    Json(payload): Json<SubmitOrderRequest>,
) -> Json<SubmitOrderResponse> {
    let mut engine = state.lock().await;
    let sequence = engine.sequence;
    engine.sequence += 1;
    let book = engine
        .books
        .entry(book_key(&payload.market_id, payload.outcome))
        .or_default();

    let mut taker = RestingOrder {
        order_id: payload.order_id.clone(),
        agent_id: payload.agent_id.clone(),
        price: payload.price,
        original_size: payload.size,
        remaining_size: payload.size,
        sequence,
    };

    let resting_orders = match payload.side {
        Side::Buy => &mut book.sell_orders,
        Side::Sell => &mut book.buy_orders,
    };
    let resting_side = match payload.side {
        Side::Buy => Side::Sell,
        Side::Sell => Side::Buy,
    };

    sort_resting_orders(resting_orders, resting_side);

    let mut fills = Vec::new();
    let mut touched_orders = Vec::new();
    let mut touched_ids = HashSet::new();

    for resting in resting_orders.iter_mut() {
        if taker.remaining_size <= f64::EPSILON {
            break;
        }

        let crosses = match payload.side {
            Side::Buy => taker.price + f64::EPSILON >= resting.price,
            Side::Sell => taker.price <= resting.price + f64::EPSILON,
        };
        if !crosses {
            break;
        }

        let matched_size = taker.remaining_size.min(resting.remaining_size);
        if matched_size <= f64::EPSILON {
            continue;
        }

        taker.remaining_size -= matched_size;
        resting.remaining_size -= matched_size;

        let (buy_order_id, sell_order_id, buy_agent_id, sell_agent_id) = match payload.side {
            Side::Buy => (
                taker.order_id.clone(),
                resting.order_id.clone(),
                taker.agent_id.clone(),
                resting.agent_id.clone(),
            ),
            Side::Sell => (
                resting.order_id.clone(),
                taker.order_id.clone(),
                resting.agent_id.clone(),
                taker.agent_id.clone(),
            ),
        };

        fills.push(FillExecution {
            fill_id: Uuid::new_v4().to_string(),
            market_id: payload.market_id.clone(),
            outcome: payload.outcome,
            price: resting.price,
            size: matched_size,
            buy_order_id,
            sell_order_id,
            buy_agent_id,
            sell_agent_id,
            executed_at: Utc::now().to_rfc3339(),
        });

        let resting_filled = resting.original_size - resting.remaining_size;
        if touched_ids.insert(resting.order_id.clone()) {
            touched_orders.push(OrderUpdate {
                order_id: resting.order_id.clone(),
                filled_size: resting_filled,
                remaining_size: resting.remaining_size,
                status: order_status(resting.original_size, resting.remaining_size),
            });
        } else if let Some(existing) = touched_orders
            .iter_mut()
            .find(|update| update.order_id == resting.order_id)
        {
            existing.filled_size = resting_filled;
            existing.remaining_size = resting.remaining_size;
            existing.status = order_status(resting.original_size, resting.remaining_size);
        }
    }

    resting_orders.retain(|entry| entry.remaining_size > f64::EPSILON);

    if taker.remaining_size > f64::EPSILON {
        let resting_side_orders = match payload.side {
            Side::Buy => &mut book.buy_orders,
            Side::Sell => &mut book.sell_orders,
        };
        resting_side_orders.push(taker.clone());
        sort_resting_orders(resting_side_orders, payload.side);
    }

    let taker_filled = taker.original_size - taker.remaining_size;
    touched_orders.push(OrderUpdate {
        order_id: taker.order_id.clone(),
        filled_size: taker_filled,
        remaining_size: taker.remaining_size,
        status: order_status(taker.original_size, taker.remaining_size),
    });

    Json(SubmitOrderResponse {
        order_id: payload.order_id,
        status: order_status(taker.original_size, taker.remaining_size),
        filled_size: taker_filled,
        remaining_size: taker.remaining_size,
        fills,
        touched_orders,
    })
}

async fn cancel_order(
    State(state): State<SharedState>,
    Json(payload): Json<CancelOrderRequest>,
) -> Json<CancelOrderResponse> {
    let mut engine = state.lock().await;
    let maybe_book = engine.books.get_mut(&book_key(&payload.market_id, payload.outcome));

    let mut canceled = false;
    if let Some(book) = maybe_book {
        let resting_orders = match payload.side {
            Side::Buy => &mut book.buy_orders,
            Side::Sell => &mut book.sell_orders,
        };
        let original_len = resting_orders.len();
        resting_orders.retain(|order| order.order_id != payload.order_id);
        canceled = resting_orders.len() != original_len;
    }

    Json(CancelOrderResponse {
        order_id: payload.order_id,
        canceled,
    })
}

#[tokio::main]
async fn main() {
    let state: SharedState = Arc::new(Mutex::new(EngineState::default()));
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/internal/orders", post(submit_order))
        .route("/v1/internal/orders/cancel", post(cancel_order))
        .with_state(state);

    let port = std::env::var("MATCHING_ENGINE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(7400);
    let address = SocketAddr::from(([0, 0, 0, 0], port));

    println!("matching-engine listening on {}", address);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind matching-engine listener");

    axum::serve(listener, app)
        .await
        .expect("serve matching-engine");
}
