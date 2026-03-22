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
use tokio_postgres::{error::SqlState, NoTls, Row};
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

const DEFAULT_DATABASE_URL: &str = "postgres://postgres:postgres@127.0.0.1:5432/agentic_polymarket";

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

fn side_from_str(value: &str) -> Option<Side> {
    match value {
        "buy" => Some(Side::Buy),
        "sell" => Some(Side::Sell),
        _ => None,
    }
}

fn outcome_from_str(value: &str) -> Option<Outcome> {
    match value {
        "YES" => Some(Outcome::YES),
        "NO" => Some(Outcome::NO),
        _ => None,
    }
}

fn insert_resting_order(
    engine: &mut EngineState,
    market_id: &str,
    outcome: Outcome,
    side: Side,
    order: RestingOrder,
) {
    let book = engine.books.entry(book_key(market_id, outcome)).or_default();
    let resting_orders = match side {
        Side::Buy => &mut book.buy_orders,
        Side::Sell => &mut book.sell_orders,
    };

    if resting_orders.iter().any(|existing| existing.order_id == order.order_id) {
        return;
    }

    resting_orders.push(order);
    sort_resting_orders(resting_orders, side);
}

fn reduce_resting_order(orders: &mut Vec<RestingOrder>, order_id: &str, matched_size: f64) {
    if let Some(order) = orders.iter_mut().find(|entry| entry.order_id == order_id) {
        order.remaining_size = (order.remaining_size - matched_size).max(0.0);
    }
    orders.retain(|entry| entry.remaining_size > f64::EPSILON);
}

fn replay_event_row(engine: &mut EngineState, row: &Row) {
    let sequence_id = row.get::<_, i64>("sequence_id").max(0) as u64;
    engine.sequence = engine.sequence.max(sequence_id.saturating_add(1));

    let event_type = row.get::<_, String>("event_type");
    let market_id = row.get::<_, String>("market_id");
    let outcome = match outcome_from_str(&row.get::<_, String>("outcome")) {
        Some(value) => value,
        None => return,
    };

    match event_type.as_str() {
        "accepted" => {
            let order_id = match row.get::<_, Option<String>>("order_id") {
                Some(value) => value,
                None => return,
            };
            let agent_id = match row.get::<_, Option<String>>("agent_id") {
                Some(value) => value,
                None => return,
            };
            let side = match row
                .get::<_, Option<String>>("side")
                .and_then(|value| side_from_str(&value))
            {
                Some(value) => value,
                None => return,
            };
            let price = match row.get::<_, Option<f64>>("price") {
                Some(value) => value,
                None => return,
            };
            let size = match row.get::<_, Option<f64>>("size") {
                Some(value) => value,
                None => return,
            };

            if size <= f64::EPSILON {
                return;
            }

            insert_resting_order(
                engine,
                &market_id,
                outcome,
                side,
                RestingOrder {
                    order_id,
                    agent_id,
                    price,
                    original_size: size,
                    remaining_size: size,
                    sequence: sequence_id,
                },
            );
        }
        "fill" => {
            let buy_order_id = match row.get::<_, Option<String>>("buy_order_id") {
                Some(value) => value,
                None => return,
            };
            let sell_order_id = match row.get::<_, Option<String>>("sell_order_id") {
                Some(value) => value,
                None => return,
            };
            let matched_size = match row.get::<_, Option<f64>>("size") {
                Some(value) => value,
                None => return,
            };

            let book = match engine.books.get_mut(&book_key(&market_id, outcome)) {
                Some(value) => value,
                None => return,
            };

            reduce_resting_order(&mut book.buy_orders, &buy_order_id, matched_size);
            reduce_resting_order(&mut book.sell_orders, &sell_order_id, matched_size);
        }
        "canceled" => {
            let order_id = match row.get::<_, Option<String>>("order_id") {
                Some(value) => value,
                None => return,
            };
            let side = match row
                .get::<_, Option<String>>("side")
                .and_then(|value| side_from_str(&value))
            {
                Some(value) => value,
                None => return,
            };
            let book = match engine.books.get_mut(&book_key(&market_id, outcome)) {
                Some(value) => value,
                None => return,
            };
            let resting_orders = match side {
                Side::Buy => &mut book.buy_orders,
                Side::Sell => &mut book.sell_orders,
            };
            resting_orders.retain(|entry| entry.order_id != order_id);
        }
        _ => {}
    }
}

async fn load_state_from_event_log(database_url: &str) -> Result<EngineState, tokio_postgres::Error> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls).await?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("matching-engine database connection error: {error}");
        }
    });

    let rows = match client
        .query(
            "
              SELECT
                sequence_id,
                event_type,
                order_id,
                market_id,
                agent_id,
                side,
                outcome,
                price,
                size,
                buy_order_id,
                sell_order_id
              FROM order_events
              ORDER BY sequence_id ASC
            ",
            &[],
        )
        .await
    {
        Ok(value) => value,
        Err(error) if error.code() == Some(&SqlState::UNDEFINED_TABLE) => return Ok(EngineState::default()),
        Err(error) => return Err(error),
    };

    let mut state = EngineState::default();
    for row in rows.iter() {
        replay_event_row(&mut state, row);
    }

    Ok(state)
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
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_string());
    let recovered_state = load_state_from_event_log(&database_url)
        .await
        .expect("load matching-engine state from order_events");
    let recovered_books = recovered_state.books.len();
    let recovered_sequence = recovered_state.sequence;
    let state: SharedState = Arc::new(Mutex::new(recovered_state));
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
    println!(
        "matching-engine recovered {} books with next sequence {}",
        recovered_books, recovered_sequence
    );

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind matching-engine listener");

    axum::serve(listener, app)
        .await
        .expect("serve matching-engine");
}
