use crate::budget::{self, Budget, Finite, Unlimited};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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

/// Implicit limits of grants created before 0.5 (policy_version 0). They keep
/// exactly their 0.4.0 behavior.
pub const LEGACY_MAX_TURNS: u64 = 12;
pub const LEGACY_MAX_MCP_CALLS: u64 = 128;
pub const LEGACY_MAX_COMPUTE_JOBS: u64 = 2;
pub const LEGACY_FILE_BYTES: u64 = 262_144;
pub const LEGACY_LINE_BYTES: u64 = 1 << 20;
pub const LEGACY_OUTPUT_BYTES: u64 = 8 << 20;
pub const LEGACY_MAX_TIMEOUT: u64 = 3600;
/// Largest single provider stdout record a policy_version 1 run buffers.
pub const RECORD_FRAME_BYTES: u64 = 64 << 20;
pub const POLICY_VERSION: u32 = 1;

/// An immutable owner grant. Persisted policy_version 1 grants store every
/// budget resolved; reading one with a budget missing fails closed.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(try_from = "GrantWire", into = "GrantWire")]
pub struct Grant {
    pub id: String,
    pub project: String,
    pub allowed_paths: Vec<String>,
    pub targets: Vec<String>,
    pub kinds: Vec<String>,
    pub expected_result: String,
    pub max_requests: Budget,
    pub max_delegations: Budget,
    pub max_hops: Budget,
    pub timeout_seconds: Budget,
    /// Unix time, or Unlimited for a grant that never expires ("never").
    pub expires_at: Budget,
    pub compute: Vec<ComputePermission>,
    /// For a legacy grant these hold its implicit 0.4 values and are not persisted.
    pub max_turns: Budget,
    pub max_mcp_calls: Budget,
    pub max_compute_jobs: Budget,
    pub policy_version: u32,
    /// Owner revocation time. Revocation also moves `expires_at` to that time.
    pub revoked_at: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct GrantWire {
    id: String,
    project: String,
    allowed_paths: Vec<String>,
    targets: Vec<String>,
    kinds: Vec<String>,
    expected_result: String,
    max_requests: Budget,
    max_delegations: Budget,
    max_hops: Budget,
    timeout_seconds: Budget,
    #[serde(with = "budget::never")]
    expires_at: Budget,
    #[serde(default)]
    compute: Vec<ComputePermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_turns: Option<Budget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_mcp_calls: Option<Budget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_compute_jobs: Option<Budget>,
    #[serde(default, skip_serializing_if = "is_zero")]
    policy_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revoked_at: Option<u64>,
}
fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl TryFrom<GrantWire> for Grant {
    type Error = String;
    fn try_from(w: GrantWire) -> Result<Self, String> {
        let (max_turns, max_mcp_calls, max_compute_jobs) = match w.policy_version {
            // Round-1 development grants may carry max_turns; 0.4 semantics win.
            0 => (
                Finite(LEGACY_MAX_TURNS),
                Finite(LEGACY_MAX_MCP_CALLS),
                Finite(LEGACY_MAX_COMPUTE_JOBS),
            ),
            POLICY_VERSION => {
                let need = |value: Option<Budget>, field: &str| {
                    value.ok_or_else(|| format!("Grant {} is missing {field}; preserve the board and restore a known backup", w.id))
                };
                (
                    need(w.max_turns, "max_turns")?,
                    need(w.max_mcp_calls, "max_mcp_calls")?,
                    need(w.max_compute_jobs, "max_compute_jobs")?,
                )
            }
            _ => return Err("Unsupported grant policy_version; upgrade CodaClauda".into()),
        };
        Ok(Grant {
            id: w.id,
            project: w.project,
            allowed_paths: w.allowed_paths,
            targets: w.targets,
            kinds: w.kinds,
            expected_result: w.expected_result,
            max_requests: w.max_requests,
            max_delegations: w.max_delegations,
            max_hops: w.max_hops,
            timeout_seconds: w.timeout_seconds,
            expires_at: w.expires_at,
            compute: w.compute,
            max_turns,
            max_mcp_calls,
            max_compute_jobs,
            policy_version: w.policy_version,
            revoked_at: w.revoked_at,
        })
    }
}

impl From<Grant> for GrantWire {
    fn from(g: Grant) -> Self {
        let current = g.policy_version > 0;
        GrantWire {
            id: g.id,
            project: g.project,
            allowed_paths: g.allowed_paths,
            targets: g.targets,
            kinds: g.kinds,
            expected_result: g.expected_result,
            max_requests: g.max_requests,
            max_delegations: g.max_delegations,
            max_hops: g.max_hops,
            timeout_seconds: g.timeout_seconds,
            expires_at: g.expires_at,
            compute: g.compute,
            max_turns: current.then_some(g.max_turns),
            max_mcp_calls: current.then_some(g.max_mcp_calls),
            max_compute_jobs: current.then_some(g.max_compute_jobs),
            policy_version: g.policy_version,
            revoked_at: g.revoked_at,
        }
    }
}

/// The limits actually enforced for a grant, including a legacy grant's
/// implicit 0.4 limits.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Effective {
    pub legacy: bool,
    pub timeout_seconds: Budget,
    pub expires_at: Budget,
    pub max_requests: Budget,
    pub max_delegations: Budget,
    pub max_hops: Budget,
    pub max_turns: Budget,
    pub max_mcp_calls: Budget,
    pub max_compute_jobs: Budget,
    /// Legacy: whole-file reads/writes of at most 256 KiB. Current: chunked, no file cap.
    pub file_bytes: Budget,
    /// Legacy: one provider line of 1 MiB. Current: a 64 MiB frame; larger records are saved.
    pub provider_record_bytes: u64,
    /// Legacy: 8 MiB of provider output. Current: no total-output cap.
    pub provider_output_bytes: Budget,
}

impl Effective {
    pub fn to_json(&self) -> Value {
        json!({
            "policy_version": if self.legacy {0} else {POLICY_VERSION},
            "timeout_seconds": self.timeout_seconds,
            "expires_at": budget::never::to_json(self.expires_at),
            "max_requests": self.max_requests,
            "max_delegations": self.max_delegations,
            "max_hops": self.max_hops,
            "max_turns": self.max_turns,
            "max_mcp_calls": self.max_mcp_calls,
            "mcp_calls_counted": if self.legacy {"every call, including wait and messages"} else {"every call except wait and messages"},
            "max_compute_jobs": self.max_compute_jobs,
            "file_io": if self.legacy {"whole-file"} else {"chunked"},
            "file_bytes": self.file_bytes,
            "provider_record_bytes": self.provider_record_bytes,
            "provider_output_bytes": self.provider_output_bytes,
        })
    }
}

pub const EXPIRED: &str =
    "OWNER_LIMIT: authorization expired or revoked; create a new authorization";

impl Grant {
    pub fn is_legacy(&self) -> bool {
        self.policy_version == 0
    }
    /// Not revoked and not past its expiry.
    pub fn is_active(&self, now: u64) -> bool {
        self.revoked_at.is_none()
            && match self.expires_at {
                Finite(at) => at > now,
                Unlimited => true,
            }
    }
    pub fn ensure_active(&self, now: u64) -> Result<()> {
        ensure!(self.is_active(now), EXPIRED);
        Ok(())
    }
    /// Seconds of grant lifetime left.
    pub fn remaining(&self, now: u64) -> Budget {
        match self.expires_at {
            Finite(at) => Finite(at.saturating_sub(now)),
            Unlimited => Unlimited,
        }
    }
    pub fn effective(&self) -> Effective {
        let legacy = self.is_legacy();
        Effective {
            legacy,
            timeout_seconds: if legacy {
                self.timeout_seconds.min(Finite(LEGACY_MAX_TIMEOUT))
            } else {
                self.timeout_seconds
            },
            expires_at: self.expires_at,
            max_requests: self.max_requests,
            max_delegations: self.max_delegations,
            max_hops: self.max_hops,
            max_turns: self.max_turns,
            max_mcp_calls: self.max_mcp_calls,
            max_compute_jobs: self.max_compute_jobs,
            file_bytes: if legacy { Finite(LEGACY_FILE_BYTES) } else { Unlimited },
            provider_record_bytes: if legacy { LEGACY_LINE_BYTES } else { RECORD_FRAME_BYTES },
            provider_output_bytes: if legacy { Finite(LEGACY_OUTPUT_BYTES) } else { Unlimited },
        }
    }
    /// Admission of one more owned Spark job for a request with `jobs` recorded.
    pub fn ensure_compute_job(&self, jobs: usize) -> Result<()> {
        if self.is_legacy() {
            ensure!(self.max_compute_jobs.allows(jobs as u64), "Spark job budget reached");
        } else {
            ensure!(
                self.max_compute_jobs.allows(jobs as u64),
                "OWNER_LIMIT: compute job budget reached (max_compute_jobs {} per request on this authorization). Create a new authorization with a higher Maximum compute jobs.",
                self.max_compute_jobs
            );
        }
        Ok(())
    }
    /// Owner-facing JSON: stored fields plus resolved `effective` limits.
    pub fn public(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("grant serializes");
        value["policy_version"] = json!(self.policy_version);
        value["revoked_at"] = json!(self.revoked_at);
        value["expires_at"] = budget::never::to_json(self.expires_at);
        value["effective"] = self.effective().to_json();
        value
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct ComputePermission {
    pub argv: Vec<String>,
    pub placement: String,
    pub runtime: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Event {
    pub seq: u64,
    pub at: u64,
    pub kind: String,
    pub data: Value,
}

/// A large text kept beside the board instead of inline (C6).
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Payload {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    /// First 16 KiB only.
    pub preview: String,
    pub preview_only: bool,
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
    /// Retained recent events; older ones are in requests/<id>.events.jsonl.
    pub events: Vec<Event>,
    #[serde(default)]
    pub spark_jobs: Vec<Value>,
    // 0.5 fields. Absent on requests written before 0.5; any present value is
    // 0.5-only data and moves the board to schema 3.
    /// Next event sequence; never derived from the retained vector once set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events_total: Option<u64>,
    /// Lifetime counted MCP calls, independent of retained events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_calls_used: Option<u64>,
    /// Last event sequence moved to the history file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spilled_through: Option<u64>,
    /// Length of the history file once `spilled_through` was committed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spilled_bytes: Option<u64>,
    /// The descendant this request is blocked on in the MCP wait tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_on: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub payloads: BTreeMap<String, Payload>,
    /// A context-read event was moved to the history file.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub context_read_spilled: bool,
    /// Events were added in this transaction (history bound check).
    #[serde(skip)]
    pub touched: bool,
}
impl Request {
    pub fn terminal(&self) -> bool {
        matches!(
            self.state.as_str(),
            "completed" | "failed" | "cancelled" | "needs-owner"
        )
    }
    pub fn next_seq(&self) -> u64 {
        self.next_seq
            .unwrap_or_else(|| self.events.last().map_or(0, |e| e.seq + 1))
    }
    pub fn events_total(&self) -> u64 {
        self.events_total.unwrap_or_else(|| self.next_seq())
    }
    /// Legacy requests counted calls by their retained mcp-call events.
    pub fn mcp_calls_used(&self) -> u64 {
        self.mcp_calls_used.unwrap_or_else(|| {
            self.events.iter().filter(|e| e.kind == "mcp-call").count() as u64
        })
    }
    pub fn has_context_read(&self) -> bool {
        self.context_read_spilled || self.events.iter().any(|e| e.kind == "context-read")
    }
    pub fn has_current_fields(&self) -> bool {
        self.next_seq.is_some()
            || self.events_total.is_some()
            || self.mcp_calls_used.is_some()
            || self.spilled_through.is_some()
            || self.spilled_bytes.is_some()
            || self.waiting_on.is_some()
            || !self.payloads.is_empty()
            || self.context_read_spilled
    }
    /// Count one MCP tool call inside the caller's authorization transaction
    /// and enforce the grant's tool-call budget (C9; legacy: C3).
    pub fn count_mcp_call(&mut self, grant: &Grant, tool: &str) -> Result<()> {
        let counted = grant.is_legacy() || !matches!(tool, "wait" | "messages");
        if !counted {
            return Ok(());
        }
        let used = self.mcp_calls_used();
        if grant.is_legacy() {
            ensure!(
                grant.max_mcp_calls.allows(used),
                "Owner tool-call budget reached; stop and report remaining work"
            );
        } else {
            ensure!(
                grant.max_mcp_calls.allows(used),
                "OWNER_LIMIT: tool-call budget reached (max_mcp_calls {} on this authorization). Create a new authorization with a higher Maximum tool calls.",
                grant.max_mcp_calls
            );
        }
        self.mcp_calls_used = Some(budget::increment(used, "mcp_calls_used")?);
        Ok(())
    }
    pub fn event(&mut self, kind: &str, data: Value) {
        self.updated_at = crate::now();
        let seq = self.next_seq();
        self.next_seq = Some(seq + 1);
        self.events_total = Some(seq + 1);
        self.touched = true;
        self.events.push(Event {
            seq,
            at: self.updated_at,
            kind: kind.into(),
            data,
        });
    }
    /// Cancellation must remain readable by an already-running 0.4 worker.
    /// Used only by the store's explicitly compatible transaction path.
    pub(crate) fn compatible_event(&mut self, legacy_board: bool, kind: &str, data: Value) {
        if !legacy_board {
            self.event(kind, data);
            return;
        }
        self.updated_at = crate::now();
        self.events.push(Event {
            seq: self.events.len() as u64,
            at: self.updated_at,
            kind: kind.into(),
            data,
        });
    }
    pub(crate) fn compatible_transition(&mut self, legacy_board: bool, state: &str, data: Value) {
        self.state = state.into();
        if self.terminal() {
            self.waiting_on = None;
        }
        self.compatible_event(legacy_board, state, data);
    }
    pub fn transition(&mut self, state: &str, data: Value) {
        self.state = state.into();
        if self.terminal() {
            self.waiting_on = None;
        }
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
            registrations: BTreeMap::new(),
            conversations: BTreeMap::new(),
            session_messages: BTreeMap::new(),
        }
    }
}
impl State {
    /// Data a 0.4 client cannot interpret: policy_version 1 grants, revocations,
    /// unlimited budgets and 0.5 request fields (C4).
    pub fn has_current_data(&self) -> bool {
        self.grants.values().any(|g| {
            !g.is_legacy()
                || g.revoked_at.is_some()
                || [g.max_requests, g.max_delegations, g.max_hops, g.timeout_seconds, g.expires_at]
                    .contains(&Unlimited)
        }) || self.requests.values().any(Request::has_current_fields)
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
