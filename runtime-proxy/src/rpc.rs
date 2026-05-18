use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
};

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::{Mutex, mpsc, oneshot},
};
use tracing::warn;

use crate::types::RpcLogEntry;

struct PendingRequest {
    tx: oneshot::Sender<Result<Value, String>>,
}

struct RequestTrace {
    method: Option<String>,
    started_at: i64,
}

pub struct PiRpcClient {
    stdin: Mutex<tokio::process::ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, PendingRequest>>,
    traces: Mutex<HashMap<String, RequestTrace>>,
    req_seq: AtomicU64,
    log_seq: AtomicU64,
    event_tx: mpsc::UnboundedSender<Value>,
    log_tx: mpsc::UnboundedSender<RpcLogEntry>,
}

impl PiRpcClient {
    pub async fn spawn(
        pi_bin: &str,
        pi_args: &[String],
        cwd: &Path,
        event_tx: mpsc::UnboundedSender<Value>,
        log_tx: mpsc::UnboundedSender<RpcLogEntry>,
    ) -> Result<Arc<Self>> {
        let mut command = Command::new(pi_bin);
        command
            .args(pi_args)
            .arg("--mode")
            .arg("rpc")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().with_context(|| {
            format!("failed to spawn `{pi_bin} --mode rpc` in {}", cwd.display())
        })?;
        let stdin = child.stdin.take().context("pi child stdin unavailable")?;
        let stdout = child.stdout.take().context("pi child stdout unavailable")?;
        let stderr = child.stderr.take().context("pi child stderr unavailable")?;

        let client = Arc::new(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            traces: Mutex::new(HashMap::new()),
            req_seq: AtomicU64::new(0),
            log_seq: AtomicU64::new(0),
            event_tx,
            log_tx,
        });

        tokio::spawn(read_stdout(stdout, client.clone()));
        tokio::spawn(read_stderr(stderr, client.clone()));
        Ok(client)
    }

    pub async fn send(&self, command: Value) -> Result<Value> {
        let mut payload = match command {
            Value::Object(map) => map,
            _ => return Err(anyhow!("RPC command must be a JSON object")),
        };
        let id = format!("r-{}", self.req_seq.fetch_add(1, Ordering::Relaxed) + 1);
        let method = payload
            .get("type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        payload.insert("id".to_string(), Value::String(id.clone()));
        let raw_value = Value::Object(payload);
        let raw = serde_json::to_string(&raw_value)?;

        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(id.clone(), PendingRequest { tx });
        self.traces.lock().await.insert(
            id.clone(),
            RequestTrace {
                method: method.clone(),
                started_at: now_ms(),
            },
        );
        self.emit_log(
            "request",
            Some(id.clone()),
            method,
            Some(raw_value.clone()),
            None,
            None,
        )
        .await;

        let write_result = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(raw.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        }
        .await;
        if let Err(err) = write_result {
            self.pending.lock().await.remove(&id);
            self.traces.lock().await.remove(&id);
            return Err(err).context("failed to write RPC command");
        }

        match rx.await.context("RPC response channel closed")? {
            Ok(value) => Ok(value),
            Err(message) => Err(anyhow!(message)),
        }
    }

    pub async fn dispose(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
    }

    async fn handle_line(&self, line: String) {
        let parsed = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => {
                self.emit_raw_log("stdout", sanitize_string(&line)).await;
                return;
            }
        };

        if parsed.get("type").and_then(Value::as_str) == Some("response") {
            self.handle_response(parsed).await;
        } else {
            let method = parsed
                .get("type")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            self.emit_log("event", None, method, Some(parsed.clone()), None, None)
                .await;
            let _ = self.event_tx.send(parsed);
        }
    }

    async fn handle_response(&self, msg: Value) {
        let id = msg.get("id").and_then(Value::as_str).map(ToOwned::to_owned);
        let trace = if let Some(id) = &id {
            self.traces.lock().await.remove(id)
        } else {
            None
        };
        let success = msg.get("success").and_then(Value::as_bool).unwrap_or(true);
        let error = msg
            .get("error")
            .and_then(Value::as_str)
            .map(sanitize_string);
        let duration = trace.as_ref().map(|trace| now_ms() - trace.started_at);
        self.emit_log(
            "response",
            id.clone(),
            trace.and_then(|trace| trace.method),
            Some(msg.clone()),
            Some(success),
            error.clone(),
        )
        .await;

        if let Some(id) = id {
            if let Some(pending) = self.pending.lock().await.remove(&id) {
                let result = if success {
                    Ok(msg.get("data").cloned().unwrap_or(Value::Null))
                } else {
                    Err(error.unwrap_or_else(|| "RPC command failed".to_string()))
                };
                let _ = pending.tx.send(result);
            }
        }

        if let Some(duration) = duration {
            let _ = duration;
        }
    }

    async fn emit_raw_log(&self, direction: &str, raw: String) {
        let _ = self.log_tx.send(RpcLogEntry {
            id: format!(
                "rpc-{}-{}",
                now_ms(),
                self.log_seq.fetch_add(1, Ordering::Relaxed) + 1
            ),
            timestamp: now_ms(),
            direction: direction.to_string(),
            request_id: None,
            method: None,
            raw: Some(raw),
            payload: None,
            success: None,
            error: None,
            duration_ms: None,
        });
    }

    async fn emit_log(
        &self,
        direction: &str,
        request_id: Option<String>,
        method: Option<String>,
        payload: Option<Value>,
        success: Option<bool>,
        error: Option<String>,
    ) {
        let sanitized = payload.map(sanitize_value);
        let raw = sanitized
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok())
            .map(|raw| sanitize_string(&raw));
        let _ = self.log_tx.send(RpcLogEntry {
            id: format!(
                "rpc-{}-{}",
                now_ms(),
                self.log_seq.fetch_add(1, Ordering::Relaxed) + 1
            ),
            timestamp: now_ms(),
            direction: direction.to_string(),
            request_id,
            method,
            raw,
            payload: sanitized,
            success,
            error,
            duration_ms: None,
        });
    }
}

async fn read_stdout(stdout: ChildStdout, client: Arc<PiRpcClient>) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                if buf.ends_with(b"\n") {
                    buf.pop();
                }
                if buf.ends_with(b"\r") {
                    buf.pop();
                }
                if buf.is_empty() {
                    continue;
                }
                match String::from_utf8(buf.clone()) {
                    Ok(line) => client.handle_line(line).await,
                    Err(err) => {
                        client
                            .emit_raw_log("stdout", sanitize_string(&err.to_string()))
                            .await
                    }
                }
            }
            Err(err) => {
                warn!(%err, "error reading pi stdout");
                break;
            }
        }
    }
}

async fn read_stderr(stderr: ChildStderr, client: Arc<PiRpcClient>) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                client
                    .emit_raw_log("stderr", sanitize_string(line.trim_end()))
                    .await
            }
            Err(err) => {
                warn!(%err, "error reading pi stderr");
                break;
            }
        }
    }
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(sanitize_string(&text)),
        Value::Array(items) => {
            Value::Array(items.into_iter().take(500).map(sanitize_value).collect())
        }
        Value::Object(map) => {
            let is_image = map.get("type").and_then(Value::as_str) == Some("image");
            let mut out = Map::new();
            for (key, value) in map.into_iter().take(200) {
                if is_sensitive_key(&key) {
                    out.insert(key, Value::String("…redacted".to_string()));
                } else if is_image && key == "data" {
                    let len = value.as_str().map(str::len).unwrap_or_default();
                    out.insert(
                        key,
                        Value::String(format!("…base64 image omitted ({len} chars)")),
                    );
                } else {
                    out.insert(key, sanitize_value(value));
                }
            }
            Value::Object(out)
        }
        other => other,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.replace([' ', '.', '-'], "_").to_ascii_lowercase();
    [
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "id_token",
        "auth_token",
        "authorization",
        "password",
        "secret",
        "credential",
        "cookie",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn sanitize_string(input: &str) -> String {
    let mut out = input.to_string();
    if let Some(idx) = out.find("sk-") {
        let end = out[idx..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .map(|off| idx + off)
            .unwrap_or(out.len());
        if end.saturating_sub(idx) > 8 {
            out.replace_range(idx..end, "sk-…redacted");
        }
    }
    if out.len() > 80_000 {
        out.truncate(80_000);
        out.push_str("\n… truncated");
    }
    out
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
