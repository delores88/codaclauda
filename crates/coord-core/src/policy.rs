//! Owner policy (policy.json): board concurrency and the defaults a new grant
//! inherits. A grant stores its resolved budgets at creation, so changing the
//! policy never changes an issued grant. Serialized under its own policy.lock.
use crate::budget::{self, Budget, Finite, Unlimited};
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantDefaults {
    pub timeout_seconds: Budget,
    pub expires_seconds: Budget,
    pub max_requests: Budget,
    pub max_delegations: Budget,
    pub max_hops: Budget,
    pub max_turns: Budget,
    pub max_mcp_calls: Budget,
    pub max_compute_jobs: Budget,
}
impl Default for GrantDefaults {
    fn default() -> Self {
        Self {
            timeout_seconds: Finite(86_400),
            expires_seconds: Finite(604_800),
            max_requests: Unlimited,
            max_delegations: Unlimited,
            max_hops: Unlimited,
            max_turns: Unlimited,
            max_mcp_calls: Unlimited,
            max_compute_jobs: Unlimited,
        }
    }
}

/// Field name and input minimum for every grant budget (C1).
pub const GRANT_FIELDS: [(&str, u64); 8] = [
    ("timeout_seconds", 10),
    ("expires_seconds", 30),
    ("max_requests", 1),
    ("max_delegations", 0),
    ("max_hops", 0),
    ("max_turns", 1),
    ("max_mcp_calls", 1),
    ("max_compute_jobs", 0),
];

impl GrantDefaults {
    pub fn get(&self, field: &str) -> Budget {
        match field {
            "timeout_seconds" => self.timeout_seconds,
            "expires_seconds" => self.expires_seconds,
            "max_requests" => self.max_requests,
            "max_delegations" => self.max_delegations,
            "max_hops" => self.max_hops,
            "max_turns" => self.max_turns,
            "max_mcp_calls" => self.max_mcp_calls,
            "max_compute_jobs" => self.max_compute_jobs,
            _ => unreachable!("unknown grant budget {field}"),
        }
    }
    fn set(&mut self, field: &str, value: Budget) {
        *match field {
            "timeout_seconds" => &mut self.timeout_seconds,
            "expires_seconds" => &mut self.expires_seconds,
            "max_requests" => &mut self.max_requests,
            "max_delegations" => &mut self.max_delegations,
            "max_hops" => &mut self.max_hops,
            "max_turns" => &mut self.max_turns,
            "max_mcp_calls" => &mut self.max_mcp_calls,
            "max_compute_jobs" => &mut self.max_compute_jobs,
            _ => unreachable!("unknown grant budget {field}"),
        } = value;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub concurrent: Budget,
    pub grant_defaults: GrantDefaults,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            concurrent: Unlimited,
            grant_defaults: GrantDefaults::default(),
        }
    }
}

fn lock(root: &Path) -> Result<fs::File> {
    Ok(OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("policy.lock"))?)
}

fn load(root: &Path) -> Result<Policy> {
    let path = root.join("policy.json");
    if !path.exists() {
        return Ok(Policy::default());
    }
    let policy: Policy = serde_json::from_slice(&fs::read(path)?)
        .context("Owner policy file is invalid; preserve policy.json and correct or remove it")?;
    // Persisted policy is a complete resolved document, never a partial update.
    // Missing fields must not silently replace owner limits with factory defaults.
    validate_budget(policy.concurrent, "concurrent", 1)?;
    for (field, min) in GRANT_FIELDS {
        validate_budget(policy.grant_defaults.get(field), field, min)?;
    }
    Ok(policy)
}

fn validate_budget(value: Budget, field: &str, min: u64) -> Result<()> {
    if let Finite(n) = value {
        ensure!((min..=budget::JS_SAFE_MAX).contains(&n), budget::invalid(field, min));
    }
    Ok(())
}

pub fn read(root: &Path) -> Result<Policy> {
    let lock = lock(root)?;
    FileExt::lock_shared(&lock)?;
    load(root)
}

pub fn update(root: &Path, change: impl FnOnce(&mut Policy) -> Result<()>) -> Result<Policy> {
    let lock = lock(root)?;
    lock.lock_exclusive()?;
    let mut policy = load(root)?;
    change(&mut policy)?;
    let mut temporary = tempfile::NamedTempFile::new_in(root)?;
    temporary.write_all(&serde_json::to_vec_pretty(&policy)?)?;
    temporary.as_file().sync_all()?;
    temporary.persist(root.join("policy.json")).map_err(|e| e.error)?;
    FileExt::unlock(&lock)?;
    Ok(policy)
}

fn concurrent(value: Option<&Value>) -> Result<Budget> {
    budget::parse_value(value, "concurrent", 1)?
        .with_context(|| budget::invalid("concurrent", 1))
}

/// Owner ops `policy`, `policy-set`, `limits` and `limits-set`.
pub fn api(root: &Path, op: &str, a: &Value) -> Result<Value> {
    match op {
        "policy" => Ok(json!(read(root)?)),
        "limits" => Ok(json!({"concurrent": read(root)?.concurrent})),
        "limits-set" => {
            let value = concurrent(a.get("concurrent"))?;
            let policy = update(root, |p| {
                p.concurrent = value;
                Ok(())
            })?;
            Ok(json!({"concurrent": policy.concurrent}))
        }
        "policy-set" => {
            let object = a.as_object().context("policy-set expects a JSON object")?;
            for key in object.keys() {
                ensure!(
                    key == "concurrent" || key == "grant_defaults",
                    "Unknown policy field {key}; use concurrent or grant_defaults"
                );
            }
            let next_concurrent = a.get("concurrent").map(|v| concurrent(Some(v))).transpose()?;
            let mut defaults = vec![];
            if let Some(given) = a.get("grant_defaults") {
                let given = given.as_object().context("grant_defaults must be an object")?;
                for (key, value) in given {
                    let Some((field, min)) = GRANT_FIELDS.iter().find(|(f, _)| f == key) else {
                        bail!("Unknown grant default {key}")
                    };
                    let value = budget::parse_value(Some(value), field, *min)?
                        .with_context(|| budget::invalid(field, *min))?;
                    defaults.push((*field, value));
                }
            }
            let policy = update(root, |p| {
                if let Some(value) = next_concurrent {
                    p.concurrent = value;
                }
                for (field, value) in defaults {
                    p.grant_defaults.set(field, value);
                }
                Ok(())
            })?;
            Ok(json!(policy))
        }
        _ => bail!("Unsupported policy operation"),
    }
}
