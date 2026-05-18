use std::{
    collections::HashMap,
    env,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, broadcast, mpsc};
use uuid::Uuid;

use crate::{
    rpc::PiRpcClient,
    types::{
        AgentEventEnvelope, AgentImageContent, AgentMessage, AgentRunState, AgentState, Chat,
        ChatRuntimeStatus, MessagePart, OpenChatRequest, PromptRequest, RpcLogEntry,
        SetModelRequest, SetThinkingLevelRequest, TokenUsageSummary,
    },
};

const RPC_LOG_LIMIT: usize = 1_000;

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub pi_bin: String,
    pub pi_args: Vec<String>,
}

#[derive(Clone)]
pub struct RuntimeManager {
    inner: Arc<RuntimeManagerInner>,
}

struct RuntimeManagerInner {
    config: ProxyConfig,
    runtimes: RwLock<HashMap<String, Arc<ChatRuntime>>>,
    events: broadcast::Sender<Value>,
    rpc_logs: RwLock<Vec<RpcLogEntry>>,
}

struct ChatRuntime {
    chat_id: String,
    project_id: String,
    chat: RwLock<Chat>,
    rpc: Arc<PiRpcClient>,
    state: RwLock<AgentState>,
    messages: RwLock<Vec<AgentMessage>>,
    seq: AtomicU64,
    current_assistant_id: Mutex<Option<String>>,
    updated_at: RwLock<i64>,
}

impl RuntimeManager {
    pub fn new(config: ProxyConfig) -> Self {
        let (events, _) = broadcast::channel(4_096);
        Self {
            inner: Arc::new(RuntimeManagerInner {
                config,
                runtimes: RwLock::new(HashMap::new()),
                events,
                rpc_logs: RwLock::new(Vec::new()),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.inner.events.subscribe()
    }

    pub async fn open_chat(&self, chat_id: String, req: OpenChatRequest) -> Result<Chat> {
        if let Some(runtime) = self.inner.runtimes.read().await.get(&chat_id).cloned() {
            return Ok(runtime.chat.read().await.clone());
        }

        let cwd = match req.cwd {
            Some(cwd) => cwd,
            None => env::current_dir().context("failed to determine current directory")?,
        };
        let project_id = req.project_id.unwrap_or_else(|| "default".to_string());
        let now = now_ms();
        let chat = Chat {
            id: chat_id.clone(),
            project_id: project_id.clone(),
            title: req.title.unwrap_or_else(|| "New chat".to_string()),
            session_file: req.session_file.clone(),
            created_at: now,
            updated_at: now,
        };

        let (raw_event_tx, raw_event_rx) = mpsc::unbounded_channel();
        let (rpc_log_tx, rpc_log_rx) = mpsc::unbounded_channel();
        let rpc = PiRpcClient::spawn(
            &self.inner.config.pi_bin,
            &self.inner.config.pi_args,
            &cwd,
            raw_event_tx,
            rpc_log_tx,
        )
        .await?;
        let runtime = Arc::new(ChatRuntime {
            chat_id: chat_id.clone(),
            project_id,
            chat: RwLock::new(chat.clone()),
            rpc,
            state: RwLock::new(AgentState::default()),
            messages: RwLock::new(Vec::new()),
            seq: AtomicU64::new(0),
            current_assistant_id: Mutex::new(None),
            updated_at: RwLock::new(now),
        });

        self.inner
            .runtimes
            .write()
            .await
            .insert(chat_id.clone(), runtime.clone());
        self.spawn_event_task(runtime.clone(), raw_event_rx);
        self.spawn_log_task(rpc_log_rx);
        self.broadcast_status(&runtime).await;

        if let Some(session_file) = req.session_file {
            if let Err(err) = runtime
                .rpc
                .send(json!({ "type": "switch_session", "sessionPath": session_file }))
                .await
                .context("failed to switch pi session")
            {
                self.inner.runtimes.write().await.remove(&chat_id);
                runtime.rpc.dispose().await;
                self.broadcast_status_removed(&runtime).await;
                return Err(err);
            }
        }

        Ok(chat)
    }

    pub async fn dispose_chat(&self, chat_id: &str) {
        if let Some(runtime) = self.inner.runtimes.write().await.remove(chat_id) {
            runtime.rpc.dispose().await;
            self.broadcast_status_removed(&runtime).await;
        }
    }

    pub async fn list_statuses(&self) -> Vec<ChatRuntimeStatus> {
        let runtimes = self.inner.runtimes.read().await;
        let mut statuses = Vec::with_capacity(runtimes.len());
        for runtime in runtimes.values() {
            statuses.push(self.status(runtime).await);
        }
        statuses
    }

    pub async fn prompt(&self, chat_id: &str, req: PromptRequest) -> Result<()> {
        let runtime = self.runtime(chat_id).await?;
        self.record_user_message(&runtime, &req).await;
        let mut cmd = json!({ "type": "prompt", "message": req.message });
        apply_prompt_options(&mut cmd, req.images, req.streaming_behavior);
        runtime.rpc.send(cmd).await?;
        Ok(())
    }

    pub async fn steer(&self, chat_id: &str, req: PromptRequest) -> Result<()> {
        let runtime = self.runtime(chat_id).await?;
        self.record_user_message(&runtime, &req).await;
        let mut cmd = json!({ "type": "steer", "message": req.message });
        apply_prompt_options(&mut cmd, req.images, None);
        runtime.rpc.send(cmd).await?;
        Ok(())
    }

    pub async fn follow_up(&self, chat_id: &str, req: PromptRequest) -> Result<()> {
        let runtime = self.runtime(chat_id).await?;
        self.record_user_message(&runtime, &req).await;
        let mut cmd = json!({ "type": "follow_up", "message": req.message });
        apply_prompt_options(&mut cmd, req.images, None);
        runtime.rpc.send(cmd).await?;
        Ok(())
    }

    pub async fn abort(&self, chat_id: &str) -> Result<()> {
        let runtime = self.runtime(chat_id).await?;
        let _ = runtime.rpc.send(json!({ "type": "abort" })).await;
        let events = self.set_run_state(&runtime, AgentRunState::Idle).await;
        for event in events {
            self.emit_agent_event(&runtime, event).await;
        }
        Ok(())
    }

    pub async fn rpc_command(&self, chat_id: &str, command: Value) -> Result<Value> {
        let runtime = self.runtime(chat_id).await?;
        runtime.rpc.send(command).await
    }

    pub async fn get_state(&self, chat_id: &str) -> Result<AgentState> {
        let runtime = self.runtime(chat_id).await?;
        if let Ok(data) = runtime.rpc.send(json!({ "type": "get_state" })).await {
            self.apply_state_response(&runtime, data).await;
        }
        if let Ok(stats) = runtime
            .rpc
            .send(json!({ "type": "get_session_stats" }))
            .await
        {
            self.apply_stats_response(&runtime, stats).await;
        }
        Ok(runtime.state.read().await.clone())
    }

    pub async fn get_messages(&self, chat_id: &str) -> Result<Vec<AgentMessage>> {
        let runtime = self.runtime(chat_id).await?;
        if let Ok(data) = runtime.rpc.send(json!({ "type": "get_messages" })).await {
            if let Some(messages) = messages_from_rpc(&data) {
                *runtime.messages.write().await = messages.clone();
                return Ok(messages);
            }
        }
        Ok(runtime.messages.read().await.clone())
    }

    pub async fn get_models(&self, chat_id: &str) -> Result<Value> {
        let runtime = self.runtime(chat_id).await?;
        let data = runtime
            .rpc
            .send(json!({ "type": "get_available_models" }))
            .await
            .unwrap_or_else(|_| json!({ "models": [] }));
        Ok(data.get("models").cloned().unwrap_or(data))
    }

    pub async fn set_model(&self, chat_id: &str, req: SetModelRequest) -> Result<()> {
        let runtime = self.runtime(chat_id).await?;
        runtime
            .rpc
            .send(json!({ "type": "set_model", "provider": req.provider, "modelId": req.model_id }))
            .await?;
        let _ = self.get_state(chat_id).await;
        Ok(())
    }

    pub async fn set_thinking_level(
        &self,
        chat_id: &str,
        req: SetThinkingLevelRequest,
    ) -> Result<()> {
        let runtime = self.runtime(chat_id).await?;
        runtime
            .rpc
            .send(json!({ "type": "set_thinking_level", "level": req.level }))
            .await?;
        let _ = self.get_state(chat_id).await;
        Ok(())
    }

    pub async fn rpc_logs(&self) -> Vec<RpcLogEntry> {
        self.inner.rpc_logs.read().await.clone()
    }

    pub async fn clear_rpc_logs(&self) {
        self.inner.rpc_logs.write().await.clear();
    }

    async fn runtime(&self, chat_id: &str) -> Result<Arc<ChatRuntime>> {
        self.inner
            .runtimes
            .read()
            .await
            .get(chat_id)
            .cloned()
            .ok_or_else(|| anyhow!("runtime not found for chat {chat_id}"))
    }

    fn spawn_event_task(&self, runtime: Arc<ChatRuntime>, mut rx: mpsc::UnboundedReceiver<Value>) {
        let manager = self.clone();
        tokio::spawn(async move {
            while let Some(raw) = rx.recv().await {
                let events = manager.normalize_rpc_event(&runtime, raw).await;
                for event in events {
                    manager.emit_agent_event(&runtime, event).await;
                }
            }
        });
    }

    fn spawn_log_task(&self, mut rx: mpsc::UnboundedReceiver<RpcLogEntry>) {
        let manager = self.clone();
        tokio::spawn(async move {
            while let Some(entry) = rx.recv().await {
                {
                    let mut logs = manager.inner.rpc_logs.write().await;
                    logs.push(entry.clone());
                    if logs.len() > RPC_LOG_LIMIT {
                        let excess = logs.len() - RPC_LOG_LIMIT;
                        logs.drain(0..excess);
                    }
                }
                let _ = manager
                    .inner
                    .events
                    .send(json!({ "type": "rpc_log", "entry": entry }));
            }
        });
    }

    async fn normalize_rpc_event(&self, runtime: &Arc<ChatRuntime>, ev: Value) -> Vec<Value> {
        match ev.get("type").and_then(Value::as_str).unwrap_or_default() {
            "agent_start" => {
                *runtime.current_assistant_id.lock().await = None;
                let mut out = self.set_run_state(runtime, AgentRunState::Thinking).await;
                out.insert(0, json!({ "type": "agent_start" }));
                out
            }
            "agent_end" => {
                let mut out = Vec::new();
                if let Some(message_id) = runtime.current_assistant_id.lock().await.take() {
                    out.push(json!({ "type": "message_end", "messageId": message_id }));
                }
                out.extend(self.set_run_state(runtime, AgentRunState::Idle).await);
                out.push(json!({ "type": "agent_end" }));
                out
            }
            "queue_update" => vec![json!({
                "type": "queue_update",
                "steering": string_array(ev.get("steering")),
                "followUp": string_array(ev.get("followUp")),
            })],
            "message_start" => {
                let role = ev
                    .get("message")
                    .and_then(|m| m.get("role"))
                    .and_then(Value::as_str);
                if role != Some("assistant") {
                    return Vec::new();
                }
                let mut guard = runtime.current_assistant_id.lock().await;
                if let Some(message_id) = guard.as_ref() {
                    vec![json!({ "type": "text_delta", "messageId": message_id, "delta": "\n\n" })]
                } else {
                    let message_id = format!("a-{}-{}", now_ms(), Uuid::new_v4().simple());
                    *guard = Some(message_id.clone());
                    vec![json!({
                        "type": "message_start",
                        "message": { "id": message_id, "role": "assistant", "time": now_hhmm(), "parts": [] }
                    })]
                }
            }
            "message_update" => {
                let inner = ev.get("assistantMessageEvent").unwrap_or(&Value::Null);
                let Some(kind) = inner.get("type").and_then(Value::as_str) else {
                    return Vec::new();
                };
                if kind == "text_delta" || kind == "thinking_delta" {
                    let Some(delta) = inner.get("delta").and_then(Value::as_str) else {
                        return Vec::new();
                    };
                    let message_id = self.ensure_assistant_message(runtime).await;
                    let mut out = if kind == "thinking_delta" {
                        self.set_run_state(runtime, AgentRunState::Thinking).await
                    } else {
                        self.set_run_state(runtime, AgentRunState::Running).await
                    };
                    out.push(json!({
                        "type": kind,
                        "messageId": message_id,
                        "delta": delta,
                    }));
                    out
                } else if kind == "error" {
                    vec![json!({ "type": "error", "message": "assistant message error" })]
                } else {
                    Vec::new()
                }
            }
            "message_end" => Vec::new(),
            "tool_execution_start" => {
                let message_id = self.ensure_assistant_message(runtime).await;
                let mut out = self.set_run_state(runtime, AgentRunState::Running).await;
                out.push(json!({
                    "type": "tool_execution_start",
                    "messageId": message_id,
                    "tool": {
                        "toolCallId": value_string(ev.get("toolCallId")),
                        "name": value_string(ev.get("toolName")),
                        "arg": extract_tool_arg(ev.get("args")),
                        "status": "running"
                    }
                }));
                out
            }
            "tool_execution_update" => {
                let Some(message_id) = runtime.current_assistant_id.lock().await.clone() else {
                    return Vec::new();
                };
                let Some(preview) = extract_tool_preview(ev.get("partialResult")) else {
                    return Vec::new();
                };
                vec![json!({
                    "type": "tool_execution_update",
                    "messageId": message_id,
                    "toolCallId": value_string(ev.get("toolCallId")),
                    "patch": { "preview": preview }
                })]
            }
            "tool_execution_end" => {
                let Some(message_id) = runtime.current_assistant_id.lock().await.clone() else {
                    return Vec::new();
                };
                vec![json!({
                    "type": "tool_execution_end",
                    "messageId": message_id,
                    "toolCallId": value_string(ev.get("toolCallId")),
                    "patch": {
                        "status": if ev.get("isError").and_then(Value::as_bool).unwrap_or(false) { "error" } else { "ok" },
                        "preview": extract_tool_preview(ev.get("result"))
                    }
                })]
            }
            "error" => vec![json!({
                "type": "error",
                "message": ev.get("message").and_then(Value::as_str).unwrap_or("pi rpc error")
            })],
            _ => Vec::new(),
        }
    }

    async fn ensure_assistant_message(&self, runtime: &Arc<ChatRuntime>) -> String {
        let mut guard = runtime.current_assistant_id.lock().await;
        if let Some(message_id) = guard.as_ref() {
            return message_id.clone();
        }
        let message_id = format!("a-{}-{}", now_ms(), Uuid::new_v4().simple());
        *guard = Some(message_id.clone());
        drop(guard);
        self.emit_agent_event(
            runtime,
            json!({
                "type": "message_start",
                "message": { "id": message_id, "role": "assistant", "time": now_hhmm(), "parts": [] }
            }),
        )
        .await;
        message_id
    }

    async fn set_run_state(
        &self,
        runtime: &Arc<ChatRuntime>,
        run_state: AgentRunState,
    ) -> Vec<Value> {
        let mut state = runtime.state.write().await;
        if state.run_state == run_state {
            return Vec::new();
        }
        state.run_state = run_state;
        let snapshot = state.clone();
        drop(state);
        *runtime.updated_at.write().await = now_ms();
        self.broadcast_status(runtime).await;
        vec![json!({ "type": "state_changed", "state": snapshot })]
    }

    async fn emit_agent_event(&self, runtime: &Arc<ChatRuntime>, event: Value) {
        self.apply_event_to_cache(runtime, &event).await;
        let envelope = AgentEventEnvelope {
            chat_id: runtime.chat_id.clone(),
            project_id: runtime.project_id.clone(),
            seq: runtime.seq.fetch_add(1, Ordering::Relaxed) + 1,
            timestamp: now_ms(),
            event,
        };
        let _ = self.inner.events.send(json!(envelope));
    }

    async fn broadcast_status(&self, runtime: &Arc<ChatRuntime>) {
        let status = self.status(runtime).await;
        let _ = self
            .inner
            .events
            .send(json!({ "type": "runtime_status", "status": status }));
    }

    async fn broadcast_status_removed(&self, runtime: &Arc<ChatRuntime>) {
        let state = runtime.state.read().await;
        let status = ChatRuntimeStatus {
            chat_id: runtime.chat_id.clone(),
            project_id: runtime.project_id.clone(),
            run_state: state.run_state,
            active: false,
            has_runtime: false,
            updated_at: now_ms(),
        };
        let _ = self
            .inner
            .events
            .send(json!({ "type": "runtime_status", "status": status }));
    }

    async fn status(&self, runtime: &Arc<ChatRuntime>) -> ChatRuntimeStatus {
        let state = runtime.state.read().await;
        ChatRuntimeStatus {
            chat_id: runtime.chat_id.clone(),
            project_id: runtime.project_id.clone(),
            run_state: state.run_state,
            active: false,
            has_runtime: true,
            updated_at: *runtime.updated_at.read().await,
        }
    }

    async fn apply_event_to_cache(&self, runtime: &Arc<ChatRuntime>, event: &Value) {
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "message_start" => {
                let Some(message) = event.get("message") else {
                    return;
                };
                let parsed = AgentMessage {
                    id: message
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    role: message
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("assistant")
                        .to_string(),
                    time: message
                        .get("time")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    parts: Vec::new(),
                };
                if parsed.id.is_empty() {
                    return;
                }
                let mut messages = runtime.messages.write().await;
                if !messages.iter().any(|message| message.id == parsed.id) {
                    messages.push(parsed);
                }
            }
            "text_delta" | "thinking_delta" => {
                let Some(message_id) = event.get("messageId").and_then(Value::as_str) else {
                    return;
                };
                let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                    return;
                };
                let mut messages = runtime.messages.write().await;
                let Some(message) = messages.iter_mut().find(|message| message.id == message_id)
                else {
                    return;
                };
                let is_thinking =
                    event.get("type").and_then(Value::as_str) == Some("thinking_delta");
                match message.parts.last_mut() {
                    Some(MessagePart::Text { text }) if !is_thinking => text.push_str(delta),
                    Some(MessagePart::Thinking { text }) if is_thinking => text.push_str(delta),
                    _ if is_thinking => message.parts.push(MessagePart::Thinking {
                        text: delta.to_string(),
                    }),
                    _ => message.parts.push(MessagePart::Text {
                        text: delta.to_string(),
                    }),
                }
            }
            "tool_execution_start" => {
                let Some(message_id) = event.get("messageId").and_then(Value::as_str) else {
                    return;
                };
                let Some(tool) = event.get("tool") else {
                    return;
                };
                let mut messages = runtime.messages.write().await;
                if let Some(message) = messages.iter_mut().find(|message| message.id == message_id)
                {
                    message.parts.push(MessagePart::Tool { tool: tool.clone() });
                }
            }
            "tool_execution_update" | "tool_execution_end" => {
                let Some(message_id) = event.get("messageId").and_then(Value::as_str) else {
                    return;
                };
                let Some(tool_call_id) = event.get("toolCallId").and_then(Value::as_str) else {
                    return;
                };
                let patch = event.get("patch").cloned().unwrap_or(Value::Null);
                let mut messages = runtime.messages.write().await;
                let Some(message) = messages.iter_mut().find(|message| message.id == message_id)
                else {
                    return;
                };
                for part in &mut message.parts {
                    if let MessagePart::Tool { tool } = part {
                        if tool.get("toolCallId").and_then(Value::as_str) == Some(tool_call_id) {
                            merge_value(tool, &patch);
                        }
                    }
                }
            }
            _ => {}
        }
        *runtime.updated_at.write().await = now_ms();
    }

    async fn record_user_message(&self, runtime: &Arc<ChatRuntime>, req: &PromptRequest) {
        let mut parts = Vec::new();
        if !req.message.trim().is_empty() {
            parts.push(MessagePart::Text {
                text: req.message.clone(),
            });
        }
        for image in &req.images {
            parts.push(MessagePart::Image {
                image: image.clone(),
            });
        }
        runtime.messages.write().await.push(AgentMessage {
            id: format!("u-{}-{}", now_ms(), Uuid::new_v4().simple()),
            role: "user".to_string(),
            time: now_hhmm(),
            parts,
        });
        *runtime.updated_at.write().await = now_ms();
    }

    async fn apply_state_response(&self, runtime: &Arc<ChatRuntime>, data: Value) {
        let mut state = runtime.state.write().await;
        if let Some(model) = data.get("model") {
            if let Some(provider) = model.get("provider").and_then(Value::as_str) {
                state.model_provider = provider.to_string();
            }
            if let Some(id) = model.get("id").and_then(Value::as_str) {
                state.model_id = id.to_string();
            }
            if let Some(context) = model.get("contextWindow").and_then(Value::as_u64) {
                state.tokens_max = context;
            }
        }
        if let Some(level) = data.get("thinkingLevel").and_then(Value::as_str) {
            state.thinking_level = level.to_string();
        }
        if let Some(session_id) = data.get("sessionId").and_then(Value::as_str) {
            state.session_id = session_id.to_string();
        }
        if let Some(enabled) = data.get("autoCompactionEnabled").and_then(Value::as_bool) {
            state.auto_compaction_enabled = enabled;
        }
        if let Some(session_file) = data.get("sessionFile").and_then(Value::as_str) {
            state.session_file = Some(session_file.to_string());
            runtime.chat.write().await.session_file = Some(session_file.to_string());
        }
    }

    async fn apply_stats_response(&self, runtime: &Arc<ChatRuntime>, stats: Value) {
        let mut state = runtime.state.write().await;
        if let Some(tokens) = stats.get("tokens") {
            let input = tokens.get("input").and_then(Value::as_u64).unwrap_or(0);
            let output = tokens.get("output").and_then(Value::as_u64).unwrap_or(0);
            let cache_read = tokens.get("cacheRead").and_then(Value::as_u64).unwrap_or(0);
            let cache_write = tokens
                .get("cacheWrite")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let total = tokens
                .get("total")
                .and_then(Value::as_u64)
                .unwrap_or(input + output + cache_read + cache_write);
            state.token_usage = TokenUsageSummary {
                input,
                output,
                cache_read,
                cache_write,
                total,
            };
        }
        if let Some(cost) = stats.get("cost").and_then(Value::as_f64) {
            state.cost_usd = cost;
        }
        if let Some(context) = stats.get("contextUsage") {
            if let Some(context_window) = context.get("contextWindow").and_then(Value::as_u64) {
                state.tokens_max = context_window;
            }
            if let Some(tokens) = context.get("tokens").and_then(Value::as_u64) {
                state.tokens_used = tokens;
            } else {
                state.tokens_used = state.token_usage.total;
            }
            if let Some(percent) = context.get("percent").and_then(Value::as_f64) {
                state.context_percent = percent;
            }
        }
    }
}

fn messages_from_rpc(data: &Value) -> Option<Vec<AgentMessage>> {
    let raw = data.get("messages")?.as_array()?;
    let mut out = Vec::new();
    for (idx, message) in raw.iter().enumerate() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(role, "user" | "assistant" | "system") {
            continue;
        }
        let parts = content_to_parts(message.get("content"));
        if parts.is_empty() {
            continue;
        }
        let prefix = role.chars().next().unwrap_or('m');
        out.push(AgentMessage {
            id: format!("{prefix}-{idx}-{}", value_string(message.get("timestamp"))),
            role: role.to_string(),
            time: message
                .get("timestamp")
                .and_then(Value::as_i64)
                .map(time_from_ms)
                .unwrap_or_else(now_hhmm),
            parts,
        });
    }
    Some(out)
}

fn content_to_parts(content: Option<&Value>) -> Vec<MessagePart> {
    let Some(content) = content else {
        return Vec::new();
    };
    if let Some(text) = content.as_str() {
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![MessagePart::Text {
                text: text.to_string(),
            }]
        };
    }
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    for block in blocks {
        let Some(kind) = block.get("type").and_then(Value::as_str) else {
            continue;
        };
        match kind {
            "text" => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    match parts.last_mut() {
                        Some(MessagePart::Text { text: existing }) => existing.push_str(text),
                        _ => parts.push(MessagePart::Text {
                            text: text.to_string(),
                        }),
                    }
                }
            }
            "image" => {
                let Some(data) = block.get("data").and_then(Value::as_str) else {
                    continue;
                };
                let mime_type = block
                    .get("mimeType")
                    .or_else(|| block.get("mime_type"))
                    .and_then(Value::as_str)
                    .unwrap_or("image/png");
                parts.push(MessagePart::Image {
                    image: AgentImageContent {
                        kind: "image".to_string(),
                        data: data.to_string(),
                        mime_type: mime_type.to_string(),
                    },
                });
            }
            _ => {}
        }
    }
    parts
}

fn apply_prompt_options(
    cmd: &mut Value,
    images: Vec<crate::types::AgentImageContent>,
    streaming: Option<String>,
) {
    if let Some(obj) = cmd.as_object_mut() {
        if !images.is_empty() {
            obj.insert("images".to_string(), json!(images));
        }
        if let Some(streaming) = streaming {
            obj.insert("streamingBehavior".to_string(), Value::String(streaming));
        }
    }
}

fn merge_value(target: &mut Value, patch: &Value) {
    let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) else {
        return;
    };
    for (key, value) in patch {
        target.insert(key.clone(), value.clone());
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn extract_tool_arg(args: Option<&Value>) -> String {
    let Some(args) = args.and_then(Value::as_object) else {
        return String::new();
    };
    for key in [
        "path",
        "file_path",
        "filename",
        "command",
        "cmd",
        "pattern",
        "query",
    ] {
        if let Some(value) = args.get(key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn extract_tool_preview(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Some(truncate(text, 4_000));
    }
    let obj = value.as_object()?;
    for key in ["content", "output"] {
        if let Some(text) = obj.get(key).and_then(Value::as_str) {
            return Some(truncate(text, 4_000));
        }
    }
    if let Some(items) = obj.get("content").and_then(Value::as_array) {
        let text = items
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    item.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return Some(truncate(&text, 4_000));
        }
    }
    None
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        format!("{}\n... ({} more chars)", &text[..max], text.len() - max)
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn now_hhmm() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

fn time_from_ms(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_else(now_hhmm)
}
