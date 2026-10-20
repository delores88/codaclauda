use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Endpoint {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub agent: String,
    pub executable: String,
    pub workspace: String,
    pub version: String,
    pub auth_status: String,
    pub mode: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Grant {
    pub id: String,
    pub project: String,
    pub allowed_paths: Vec<String>,
    pub targets: Vec<String>,
    pub kinds: Vec<String>,
    pub expected_result: String,
    pub max_requests: usize,
    pub max_delegations: usize,
    pub max_hops: u32,
    pub timeout_seconds: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub compute: Vec<ComputePermission>,
    /// Provider turns per run. Grants saved before 0.5 read as the default.
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    /// Owner revocation time. Revocation also moves `expires_at` to that time.
    #[serde(default)]
    pub revoked_at: Option<u64>,
}

pub const DEFAULT_MAX_TURNS: u32 = 200;
fn default_max_turns() -> u32 {
    DEFAULT_MAX_TURNS
}

/// Owner-set board limits. Missing in boards saved before 0.5.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct BoardLimits {
    #[serde(default = "default_concurrent")]
    pub concurrent: u32,
}
pub const DEFAULT_CONCURRENT: u32 = 4;
fn default_concurrent() -> u32 {
    DEFAULT_CONCURRENT
}
impl Default for BoardLimits {
    fn default() -> Self {
        Self {
            concurrent: DEFAULT_CONCURRENT,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct ComputePermission {
    pub argv: Vec<String>,
    pub placement: String,
    pub runtime: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Event {
    pub seq: usize,
    pub at: u64,
    pub kind: String,
    pub data: Value,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Request {
    pub id: String,
    pub digest: String,
    pub grant_id: String,
    pub target: String,
    pub kind: String,
    pub prompt: String,
    pub expected_result: String,
    pub origin: String,
    pub origin_session: Option<String>,
    pub parent_id: Option<String>,
    pub root_id: String,
    pub hop: u32,
    pub state: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub workspace: Option<String>,
    pub session_id: Option<String>,
    pub answer: Option<String>,
    pub receipt: Option<Value>,
    pub blocker: Option<String>,
    pub cancel_requested: bool,
    pub worker_claim: Option<String>,
    pub capability_hash: String,
    pub events: Vec<Event>,
    #[serde(default)]
    pub spark_jobs: Vec<Value>,
}
impl Request {
    pub fn terminal(&self) -> bool {
        matches!(
            self.state.as_str(),
            "completed" | "failed" | "cancelled" | "needs-owner"
        )
    }
    pub fn event(&mut self, kind: &str, data: Value) {
        self.updated_at = crate::now();
        self.events.push(Event {
            seq: self.events.len(),
            at: self.updated_at,
            kind: kind.into(),
            data,
        });
    }
    pub fn transition(&mut self, state: &str, data: Value) {
        self.state = state.into();
        self.event(state, data);
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    pub schema_version: u32,
    pub endpoints: BTreeMap<String, Endpoint>,
    pub grants: BTreeMap<String, Grant>,
    pub requests: BTreeMap<String, Request>,
    pub paused: bool,
    pub spark: Option<String>,
    #[serde(default)]
    pub limits: BoardLimits,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub registrations: BTreeMap<String, SessionRegistration>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub conversations: BTreeMap<String, SessionConversation>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub session_messages: BTreeMap<String, SessionMessage>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: 1,
            endpoints: BTreeMap::new(),
            grants: BTreeMap::new(),
            requests: BTreeMap::new(),
            paused: false,
            spark: None,
            limits: BoardLimits::default(),
            registrations: BTreeMap::new(),
            conversations: BTreeMap::new(),
            session_messages: BTreeMap::new(),
        }
    }
}

/// Private on-disk registration. Use session::public_registration for UI/MCP.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SessionRegistration {
    pub id: String,
    pub provider: String,
    pub chat_id: String,
    pub label: String,
    pub project: String,
    pub mode: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub revoked_at: Option<u64>,
    pub capability_hash: String,
    pub codex_executable: Option<String>,
    pub codex_socket: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SessionConversation {
    pub id: String,
    pub digest: String,
    pub registrations: [String; 2],
    pub project: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub max_messages: u32,
    pub max_hops: u32,
    pub revoked_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SessionMessage {
    pub id: String,
    pub digest: String,
    pub seq: u64,
    pub conversation_id: String,
    pub sender: String,
    pub recipient: String,
    pub sender_label: String,
    pub recipient_label: String,
    pub body: String,
    pub created_at: u64,
    pub parent_id: Option<String>,
    pub root_id: String,
    pub hop: u32,
    pub phase: String,
    pub acknowledged_at: Option<u64>,
    pub reply_id: Option<String>,
    pub transport_claim_hash: Option<String>,
    pub transport_receipt: Option<Value>,
}
