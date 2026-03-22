use axum::{routing::get, Json, Router};
use serde::Serialize;
use std::net::SocketAddr;

#[derive(Serialize)]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        service: "matching-engine",
        status: "ok",
    })
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/health", get(health));
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
