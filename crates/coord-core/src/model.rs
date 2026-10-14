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
        }
    }
}
