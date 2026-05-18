use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub session_file: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenChatRequest {
    pub project_id: Option<String>,
    pub cwd: Option<PathBuf>,
    pub session_file: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentImageContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    #[serde(default, alias = "text")]
    pub message: String,
    #[serde(default)]
    pub images: Vec<AgentImageContent>,
    #[serde(default)]
    pub streaming_behavior: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModelRequest {
    pub provider: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetThinkingLevelRequest {
    pub level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwitchSessionRequest {
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRunState {
    Idle,
    Thinking,
    Running,
    Queued,
}

impl Default for AgentRunState {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSummary {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

impl Default for TokenUsageSummary {
    fn default() -> Self {
        Self {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            total: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub run_state: AgentRunState,
    pub model_provider: String,
    pub model_id: String,
    pub thinking_level: String,
    pub tokens_used: u64,
    pub tokens_max: u64,
    pub token_usage: TokenUsageSummary,
    pub cost_usd: f64,
    pub context_percent: f64,
    pub auto_compaction_enabled: bool,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            run_state: AgentRunState::Idle,
            model_provider: "unknown".to_string(),
            model_id: "unknown".to_string(),
            thinking_level: "medium".to_string(),
            tokens_used: 0,
            tokens_max: 200_000,
            token_usage: TokenUsageSummary::default(),
            cost_usd: 0.0,
            context_percent: 0.0,
            auto_compaction_enabled: true,
            session_id: "pending".to_string(),
            session_file: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MessagePart {
    Text { text: String },
    Thinking { text: String },
    Tool { tool: Value },
    Image { image: AgentImageContent },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub role: String,
    pub time: String,
    pub parts: Vec<MessagePart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRuntimeStatus {
    pub chat_id: String,
    pub project_id: String,
    pub run_state: AgentRunState,
    pub active: bool,
    pub has_runtime: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub chat_id: String,
    pub project_id: String,
    pub seq: u64,
    pub timestamp: i64,
    pub event: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcLogEntry {
    pub id: String,
    pub timestamp: i64,
    pub direction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}
