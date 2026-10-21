//! Board scheduler (C7). The owner's `concurrent` bounds ACTIVE requests:
//! claimed, non-terminal and not waiting. A request is waiting while it is
//! blocked in the MCP wait tool on one of its descendants. A finite limit is
//! never exceeded: a waiter becomes active again when the request it waits on
//! finishes (that request's slot passes to it), or when it makes another tool
//! call while a slot is free; otherwise that call is refused with SLOT_BUSY and
//! it stays waiting, including after a wait that timed out. One request runs per
//! endpoint. Cycles in the wait-for graph are refused before they deadlock.
use crate::budget::Budget;
use crate::model::{Request, State};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub active: u64,
    pub waiting: u64,
    pub queued: u64,
}

fn claimed(r: &Request) -> bool {
    r.worker_claim.is_some() && !r.terminal()
}

fn runnable(r: &Request) -> bool {
    r.state == "queued" && !r.cancel_requested && r.worker_claim.is_none()
}

/// The live request this claimed request is blocked on, if any.
fn waited_on<'a>(s: &'a State, r: &'a Request) -> Option<&'a str> {
    if !claimed(r) {
        return None;
    }
    r.waiting_on
        .as_deref()
        .filter(|id| s.requests.get(*id).is_some_and(|w| !w.terminal()))
}

pub fn is_waiting(s: &State, r: &Request) -> bool {
    waited_on(s, r).is_some()
}

pub fn counts(s: &State) -> Counts {
    let mut counts = Counts::default();
    for r in s.requests.values() {
        if claimed(r) {
            if is_waiting(s, r) {
                counts.waiting += 1;
            } else {
                counts.active += 1;
            }
        } else if runnable(r) {
            counts.queued += 1;
        }
    }
    counts
}

pub fn endpoint_holder<'a>(s: &'a State, endpoint: &str) -> Option<&'a Request> {
    s.requests
        .values()
        .find(|r| claimed(r) && r.target == endpoint)
}

/// Next request to launch: first those a waiting request is blocked on, then
/// everything else, oldest first; only while a slot and its endpoint are free.
pub fn pick(s: &State, concurrent: Budget) -> Option<String> {
    if !concurrent.allows(counts(s).active) {
        return None;
    }
    let busy: BTreeSet<&str> = s
        .requests
        .values()
        .filter(|r| claimed(r))
        .map(|r| r.target.as_str())
        .collect();
    let wanted: BTreeSet<&str> = s.requests.values().filter_map(|r| waited_on(s, r)).collect();
    s.requests
        .values()
        .filter(|r| runnable(r) && !busy.contains(r.target.as_str()))
        .min_by_key(|r| (!wanted.contains(r.id.as_str()), r.created_at, r.id.as_str()))
        .map(|r| r.id.clone())
}

/// Why a queued request has not launched yet; `counts` is `counts(s)`.
pub fn queued_reason(s: &State, counts: Counts, r: &Request, concurrent: Budget) -> Option<String> {
    if !runnable(r) {
        return None;
    }
    if let Some(holder) = endpoint_holder(s, &r.target) {
        return Some(format!("endpoint {} busy with request {}", r.target, holder.id));
    }
    let active = counts.active;
    if !concurrent.allows(active) {
        return Some(format!("waiting for a free slot (active {active} of {concurrent})"));
    }
    Some(if s.paused {
        "dispatch is paused by the owner".into()
    } else {
        "ready to dispatch".into()
    })
}

/// The wait-for edge leaving `id`: a waiting request points at the request it
/// waits on; a queued request points at the request running on its endpoint.
fn edge<'a>(s: &'a State, id: &str) -> Option<&'a str> {
    let r = s.requests.get(id)?;
    if claimed(r) {
        waited_on(s, r)
    } else if runnable(r) {
        endpoint_holder(s, &r.target).map(|h| h.id.as_str())
    } else {
        None
    }
}

/// Follow edges from `from`; the path if it reaches `to`.
fn path_to(s: &State, from: Option<&str>, to: &str) -> Option<Vec<String>> {
    let mut path = Vec::new();
    let mut seen = BTreeSet::new();
    let mut at = from;
    while let Some(id) = at {
        path.push(id.to_owned());
        if id == to {
            return Some(path);
        }
        if !seen.insert(id.to_owned()) {
            return None;
        }
        at = edge(s, id);
    }
    None
}

pub fn cycle_message(path: &[String]) -> String {
    format!(
        "CYCLE: {} ; answer from your own context or ask a different peer",
        path.join(" → ")
    )
}

/// `waiter` starting to wait on `waited` would close a cycle.
pub fn wait_cycle(s: &State, waiter: &str, waited: &str) -> Option<Vec<String>> {
    let mut rest = path_to(s, Some(waited), waiter)?;
    rest.insert(0, waiter.to_owned());
    Some(rest)
}

/// A new child of `parent` targeting `target` would deadlock its parent once
/// the parent waits for it: the child queues behind the request holding its
/// endpoint, whose wait chain leads back to the parent.
pub fn submit_cycle(s: &State, parent: &str, child: &str, target: &str) -> Option<Vec<String>> {
    let holder = endpoint_holder(s, target)?.id.as_str();
    let mut rest = path_to(s, Some(holder), parent)?;
    rest.splice(0..0, [parent.to_owned(), child.to_owned()]);
    Some(rest)
}

/// `ancestor` is on `child`'s parent chain (any depth).
pub fn is_descendant(s: &State, child: &str, ancestor: &str) -> bool {
    let mut seen = BTreeSet::new();
    let mut at = s.requests.get(child).and_then(|r| r.parent_id.as_deref());
    while let Some(id) = at {
        if id == ancestor {
            return true;
        }
        if !seen.insert(id) {
            return false;
        }
        at = s.requests.get(id).and_then(|r| r.parent_id.as_deref());
    }
    false
}
