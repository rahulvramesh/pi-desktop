mod db;
mod proxy;
mod rpc;
mod types;

use std::{convert::Infallible, env, net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::broadcast};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    db::ProxyDb,
    proxy::{ProxyConfig, RuntimeManager},
    types::{
        Chat, OpenChatRequest, PromptRequest, SetModelRequest, SetThinkingLevelRequest,
        SwitchSessionRequest,
    },
};

#[derive(Clone)]
struct AppState {
    manager: RuntimeManager,
    db: ProxyDb,
    auth_token: Arc<String>,
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "pi_runtime_proxy=info,tower_http=info".into()),
        )
        .init();

    let host = env::var("PI_PROXY_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("PI_PROXY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3939);
    let pi_bin = env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string());
    let pi_args = env::var("PI_BIN_ARGS")
        .ok()
        .map(|args| args.split_whitespace().map(ToOwned::to_owned).collect())
        .unwrap_or_default();
    let (token, generated_token) = match env::var("PI_PROXY_TOKEN") {
        Ok(token) => (token, false),
        Err(_) => (Uuid::new_v4().to_string(), true),
    };
    let db_path = env::var("PI_PROXY_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".pi-desktop-proxy.db")
        });

    let state = AppState {
        manager: RuntimeManager::new(ProxyConfig { pi_bin, pi_args }),
        db: ProxyDb::open(&db_path)?,
        auth_token: Arc::new(token),
    };

    info!(
        host = %host,
        port,
        token = if generated_token { state.auth_token.as_str() } else { "provided" },
        db = %db_path.display(),
        "starting Pi runtime proxy; pass Authorization: Bearer <token>"
    );

    let protected = Router::new()
        .route("/api/runtimes", get(list_runtimes))
        .route("/api/events", get(events_ws))
        .route("/api/events/sse", get(events_sse))
        .route("/api/meta", get(meta))
        .route("/api/prefs", get(get_prefs).patch(set_prefs))
        .route(
            "/api/dev/rpc-logs",
            get(list_rpc_logs).delete(clear_rpc_logs),
        )
        .route("/api/projects", get(list_projects).post(add_project))
        .route("/api/projects/pick", post(project_pick_unavailable))
        .route("/api/projects/icon", get(project_icon))
        .route("/api/projects/{project_id}", delete(remove_project))
        .route(
            "/api/projects/{project_id}/chats",
            get(list_chats).post(create_chat),
        )
        .route(
            "/api/chats/{chat_id}",
            patch(rename_chat).delete(delete_chat),
        )
        .route("/api/chats/{chat_id}/open", post(open_chat))
        .route("/api/chats/{chat_id}/prompt", post(prompt))
        .route("/api/chats/{chat_id}/steer", post(steer))
        .route("/api/chats/{chat_id}/follow-up", post(follow_up))
        .route("/api/chats/{chat_id}/abort", post(abort))
        .route("/api/chats/{chat_id}/state", get(get_state))
        .route("/api/chats/{chat_id}/messages", get(get_messages))
        .route("/api/chats/{chat_id}/models", get(get_models))
        .route("/api/chats/{chat_id}/model", post(set_model))
        .route(
            "/api/chats/{chat_id}/thinking-level",
            post(set_thinking_level),
        )
        .route("/api/chats/{chat_id}/new-session", post(new_session))
        .route("/api/chats/{chat_id}/switch-session", post(switch_session))
        .route("/api/chats/{chat_id}/fork", post(fork))
        .route("/api/fs/tree", get(fs_tree_unavailable))
        .route("/api/git/status", get(git_status_unavailable))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));

    let app = Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .context("invalid PI_PROXY_HOST/PI_PROXY_PORT")?;
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        warn!(%err, "failed to listen for ctrl-c");
    }
}

async fn auth(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let header_ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == state.auth_token.as_str());
    let query_ok = query
        .token
        .as_deref()
        .is_some_and(|token| token == state.auth_token.as_str());
    if header_ok || query_ok {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response()
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "pi-runtime-proxy" }))
}

async fn meta() -> Json<Value> {
    Json(json!({
        "backend": "rpc-local",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
    }))
}

async fn list_runtimes(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.manager.list_statuses().await))
}

async fn events_ws(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| events_socket(socket, state.manager.subscribe()))
}

async fn events_sse(State(state): State<AppState>) -> Response {
    let rx = state.manager.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        let payload = match rx.recv().await {
            Ok(value) => value,
            Err(broadcast::error::RecvError::Lagged(_)) => json!({ "type": "resync_required" }),
            Err(broadcast::error::RecvError::Closed) => return None,
        };
        let chunk = Bytes::from(format!("data: {}\n\n", payload));
        Some((Ok::<Bytes, Infallible>(chunk), rx))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn events_socket(socket: WebSocket, mut rx: broadcast::Receiver<Value>) {
    let (mut sender, mut receiver) = socket.split();
    let mut ping = tokio::time::interval(std::time::Duration::from_secs(25));
    loop {
        tokio::select! {
            biased;
            msg = rx.recv() => {
                match msg {
                    Ok(value) => {
                        if sender.send(Message::Text(value.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = sender.send(Message::Text(json!({ "type": "resync_required" }).to_string().into())).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ping.tick() => {
                if sender.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

async fn open_chat(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    body: Option<Json<OpenChatRequest>>,
) -> Result<Json<Chat>, ApiError> {
    let mut req = body.map(|Json(req)| req).unwrap_or(OpenChatRequest {
        project_id: None,
        cwd: None,
        session_file: None,
        title: None,
    });

    if let Some(chat) = state.db.get_chat(&chat_id)? {
        if let Some(project) = state.db.get_project(&chat.project_id)? {
            req.project_id.get_or_insert(chat.project_id.clone());
            req.cwd.get_or_insert(PathBuf::from(project.path));
            if req.session_file.is_none() {
                req.session_file = chat.session_file.clone();
            }
            req.title.get_or_insert(chat.title);
        }
    }

    let chat = state.manager.open_chat(chat_id, req).await?;
    let _ = state.db.touch_project(&chat.project_id);
    let _ = state.db.touch_chat(&chat.id);
    Ok(Json(chat))
}

async fn prompt(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<PromptRequest>,
) -> Result<StatusCode, ApiError> {
    state.manager.prompt(&chat_id, req).await?;
    Ok(StatusCode::ACCEPTED)
}

async fn steer(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<PromptRequest>,
) -> Result<StatusCode, ApiError> {
    state.manager.steer(&chat_id, req).await?;
    Ok(StatusCode::ACCEPTED)
}

async fn follow_up(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<PromptRequest>,
) -> Result<StatusCode, ApiError> {
    state.manager.follow_up(&chat_id, req).await?;
    Ok(StatusCode::ACCEPTED)
}

async fn abort(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.manager.abort(&chat_id).await?;
    Ok(StatusCode::ACCEPTED)
}

async fn get_state(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_state = state.manager.get_state(&chat_id).await?;
    if let Some(session_file) = agent_state.session_file.as_deref() {
        let _ = state.db.set_session_file(&chat_id, session_file);
    }
    Ok(Json(json!(agent_state)))
}

async fn get_messages(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!(state.manager.get_messages(&chat_id).await?)))
}

async fn get_models(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.manager.get_models(&chat_id).await?))
}

async fn set_model(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<SetModelRequest>,
) -> Result<StatusCode, ApiError> {
    state.manager.set_model(&chat_id, req).await?;
    Ok(StatusCode::ACCEPTED)
}

async fn set_thinking_level(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<SetThinkingLevelRequest>,
) -> Result<StatusCode, ApiError> {
    state.manager.set_thinking_level(&chat_id, req).await?;
    Ok(StatusCode::ACCEPTED)
}

async fn new_session(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .manager
        .rpc_command(&chat_id, json!({ "type": "new_session" }))
        .await?;
    Ok(StatusCode::ACCEPTED)
}

async fn switch_session(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<SwitchSessionRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .manager
        .rpc_command(
            &chat_id,
            json!({ "type": "switch_session", "sessionPath": req.path }),
        )
        .await?;
    Ok(StatusCode::ACCEPTED)
}

async fn fork(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<StatusCode, ApiError> {
    let entry_id = body
        .get("entryId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    state
        .manager
        .rpc_command(&chat_id, json!({ "type": "fork", "entryId": entry_id }))
        .await?;
    Ok(StatusCode::ACCEPTED)
}

async fn list_rpc_logs(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.manager.rpc_logs().await))
}

async fn clear_rpc_logs(State(state): State<AppState>) -> StatusCode {
    state.manager.clear_rpc_logs().await;
    StatusCode::NO_CONTENT
}

async fn get_prefs() -> Json<Value> {
    Json(json!({
        "theme": "light",
        "accent": "#c84a1f",
        "density": "regular",
        "sidebarVisible": true,
        "rightPane": "files",
        "devMode": true,
        "agentStateOverride": "auto",
        "hasSeenWelcome": true,
        "turnEndNotifyEnabled": false,
        "turnEndNotifySound": false,
        "turnEndNotifyToast": false,
        "turnEndNotifyAttention": false,
        "turnEndNotifyOnlyWhenUnfocused": true
    }))
}

async fn set_prefs(Json(patch): Json<Value>) -> Json<Value> {
    Json(patch)
}

async fn list_projects(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!(state.db.list_projects()?)))
}

async fn add_project(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| ApiError(anyhow::anyhow!("project path is required")))?;
    let name = body.get("name").and_then(Value::as_str);
    Ok(Json(json!(state.db.add_project(path, name)?)))
}

async fn project_pick_unavailable() -> Json<Value> {
    Json(Value::Null)
}

async fn project_icon() -> Json<Value> {
    Json(Value::Null)
}

async fn remove_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    for chat in state.db.list_chats(&project_id)? {
        state.manager.dispose_chat(&chat.id).await;
    }
    state.db.remove_project(&project_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_chats(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!(state.db.list_chats(&project_id)?)))
}

async fn create_chat(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let title = body.get("title").and_then(Value::as_str);
    Ok(Json(json!(state.db.create_chat(&project_id, title)?)))
}

async fn rename_chat(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<StatusCode, ApiError> {
    if let Some(title) = body.get("title").and_then(Value::as_str) {
        state.db.rename_chat(&chat_id, title)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_chat(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.manager.dispose_chat(&chat_id).await;
    state.db.delete_chat(&chat_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn fs_tree_unavailable() -> Json<Value> {
    Json(json!([]))
}

async fn git_status_unavailable() -> Json<Value> {
    Json(json!({ "branch": null, "modified": 0 }))
}

#[derive(Debug)]
struct ApiError(anyhow::Error);

impl<E> From<E> for ApiError
where
    E: Into<anyhow::Error>,
{
    fn from(value: E) -> Self {
        Self(value.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let msg = self.0.to_string();
        let status = if msg.contains("not found") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
