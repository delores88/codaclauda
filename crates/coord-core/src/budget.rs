//! Owner budgets: a finite whole number or an explicit "unlimited".
//! Only the literal "unlimited" (or "never" for an expiry) becomes Unlimited;
//! nothing saturates into it, and a missing persisted value is never Unlimited.
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use serde_json::Value;
use std::fmt;

/// Largest whole number a JavaScript client can represent exactly.
pub const JS_SAFE_MAX: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Budget {
    Finite(u64),
    Unlimited,
}
pub use Budget::{Finite, Unlimited};

impl Budget {
    /// One more use is allowed after `used` uses.
    pub fn allows(self, used: u64) -> bool {
        match self {
            Finite(limit) => used < limit,
            Unlimited => true,
        }
    }
    /// `value` is within an inclusive bound (hop index, elapsed seconds).
    pub fn permits(self, value: u64) -> bool {
        match self {
            Finite(limit) => value <= limit,
            Unlimited => true,
        }
    }
    pub fn finite(self) -> Option<u64> {
        match self {
            Finite(limit) => Some(limit),
            Unlimited => None,
        }
    }
    pub fn min(self, other: Budget) -> Budget {
        match (self, other) {
            (Finite(a), Finite(b)) => Finite(a.min(b)),
            (Finite(a), Unlimited) | (Unlimited, Finite(a)) => Finite(a),
            (Unlimited, Unlimited) => Unlimited,
        }
    }
    pub fn to_json(self) -> Value {
        serde_json::to_value(self).expect("budget serializes")
    }
}

impl fmt::Display for Budget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Finite(limit) => write!(f, "{limit}"),
            Unlimited => f.write_str("unlimited"),
        }
    }
}

impl Serialize for Budget {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Finite(limit) => serializer.serialize_u64(*limit),
            Unlimited => serializer.serialize_str("unlimited"),
        }
    }
}

struct BudgetVisitor(&'static str);
impl de::Visitor<'_> for BudgetVisitor {
    type Value = Budget;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "a whole number or \"{}\"", self.0)
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Budget, E> {
        Ok(Finite(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Budget, E> {
        u64::try_from(value)
            .map(Finite)
            .map_err(|_| E::custom("budget cannot be negative"))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Budget, E> {
        if value == self.0 {
            Ok(Unlimited)
        } else {
            Err(E::invalid_value(de::Unexpected::Str(value), &self))
        }
    }
}

impl<'de> Deserialize<'de> for Budget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(BudgetVisitor("unlimited"))
    }
}

/// An absolute expiry: a Unix time, or "never".
pub mod never {
    use super::*;
    pub fn serialize<S: Serializer>(value: &Budget, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Finite(at) => serializer.serialize_u64(*at),
            Unlimited => serializer.serialize_str("never"),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Budget, D::Error> {
        deserializer.deserialize_any(BudgetVisitor("never"))
    }
    pub fn to_json(value: Budget) -> Value {
        match value {
            Finite(at) => Value::from(at),
            Unlimited => Value::from("never"),
        }
    }
}

pub fn invalid(field: &str, min: u64) -> String {
    format!("{field} must be a whole number from {min} to {JS_SAFE_MAX}, or \"unlimited\"")
}

pub fn too_large(field: &str) -> anyhow::Error {
    anyhow!("{field} is too large to schedule; choose a smaller value or \"unlimited\"")
}

/// Parse one owner input value. `None` means inherit the owner default.
pub fn parse_value(value: Option<&Value>, field: &str, min: u64) -> Result<Option<Budget>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text))
            if text == "unlimited" || (field == "expires_seconds" && text == "never") =>
        {
            Ok(Some(Unlimited))
        }
        Some(other) => match other.as_u64() {
            Some(n) if (min..=JS_SAFE_MAX).contains(&n) => Ok(Some(Finite(n))),
            _ => bail!(invalid(field, min)),
        },
    }
}

pub fn parse(input: &Value, field: &str, min: u64) -> Result<Option<Budget>> {
    parse_value(input.get(field), field, min)
}

/// Checked counter increment; never wraps or saturates.
pub fn increment(value: u64, field: &str) -> Result<u64> {
    value.checked_add(1).ok_or_else(|| too_large(field))
}
