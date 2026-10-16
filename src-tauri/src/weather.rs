//! Live City weather. Current conditions come from MET Norway's Locationforecast 2.0 (compact)
//! and place search from OpenStreetMap Nominatim: both free and keyless. Requests are HTTPS
//! only, time out after 15 s, cap the response size and identify CodaClauda in the User-Agent
//! as both services' terms require. Coordinates are rounded to 2 decimals (about 1 km) before
//! anything leaves this process; nothing else about the user is sent. MET answers are cached
//! per rounded coordinate until their Expires time and revalidated with If-Modified-Since.
//! Nominatim runs only on an explicit search, at most once a second process-wide, and its
//! answers are cached for a day. Both commands use the same envelope as `rpc`.

use crate::error;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

const MET_URL: &str = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const NOMINATIM_URL: &str = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const MET_BODY_LIMIT: usize = 2 * 1024 * 1024; // a compact forecast is about 50-100 KiB
const PLACES_BODY_LIMIT: usize = 256 * 1024;
const MET_CACHE_LIMIT: usize = 64;
const PLACES_CACHE_LIMIT: usize = 64;
const PLACES_CACHE_TTL: Duration = Duration::from_secs(24 * 3600);
const NOMINATIM_GAP: Duration = Duration::from_secs(1);
const FRESH_MIN: Duration = Duration::from_secs(60);
const FRESH_MAX: Duration = Duration::from_secs(6 * 3600);
const FRESH_DEFAULT: Duration = Duration::from_secs(30 * 60);
const QUERY_MIN: usize = 2;
const QUERY_MAX: usize = 100;
const PLACE_LIMIT: usize = 5;
const NAME_LIMIT: usize = 120;
const DISPLAY_LIMIT: usize = 300;

type Failure = (&'static str, String);

/// Error codes for one upstream service.
struct Codes {
    service: &'static str,
    unavailable: &'static str,
    too_large: &'static str,
    bad: &'static str,
}
const MET: Codes = Codes {
    service: "MET Norway",
    unavailable: "WEATHER_UNAVAILABLE",
    too_large: "WEATHER_TOO_LARGE",
    bad: "WEATHER_BAD_RESPONSE",
};
const NOMINATIM: Codes = Codes {
    service: "OpenStreetMap place search",
    unavailable: "GEOCODE_UNAVAILABLE",
    too_large: "GEOCODE_TOO_LARGE",
    bad: "GEOCODE_BAD_RESPONSE",
};

fn ok(data: Value) -> Value {
    json!({"ok": true, "data": data})
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    (code, message.into())
}

/// MET and Nominatim both require an identifying User-Agent with a contact.
fn user_agent() -> String {
    format!(
        "CodaClauda/{} github.com/delores88/codaclauda",
        env!("CARGO_PKG_VERSION")
    )
}

/// One shared HTTPS-only client (redirects stay HTTPS too). No gzip: reqwest's gzip feature
/// needs a crate this build does not lock, so responses arrive uncompressed and size-capped.
fn client(codes: &Codes) -> Result<&'static reqwest::Client, Failure> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .https_only(true)
        .user_agent(user_agent())
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| {
            fail(
                codes.unavailable,
                format!("The weather connection could not start: {e}"),
            )
        })?;
    Ok(CLIENT.get_or_init(|| built))
}

fn unreached(codes: &Codes, e: reqwest::Error) -> Failure {
    let reason = if e.is_timeout() {
        "the request timed out".to_owned()
    } else if e.is_connect() {
        "no connection".to_owned()
    } else {
        e.without_url().to_string()
    };
    fail(
        codes.unavailable,
        format!("{} could not be reached ({reason}).", codes.service),
    )
}

/// Reads at most `limit` bytes of a response body.
async fn read_limited(
    mut response: reqwest::Response,
    limit: usize,
    codes: &Codes,
) -> Result<Vec<u8>, Failure> {
    let too_large = || {
        fail(
            codes.too_large,
            format!(
                "{}'s response exceeded the {} KiB limit.",
                codes.service,
                limit / 1024
            ),
        )
    };
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| unreached(codes, e))? {
        if body.len() + chunk.len() > limit {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Rounds to 2 decimals (about 1 km), never -0. MET forbids more than 4.
fn round2(value: f64) -> f64 {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded == 0.0 { 0.0 } else { rounded }
}

/// A latitude (limit 90) or longitude (limit 180) in degrees, rounded to 2 decimals.
fn coordinate(value: &Value, limit: f64, name: &str) -> Result<f64, Failure> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= limit)
        .map(round2)
        .ok_or_else(|| {
            fail(
                "WEATHER_INVALID_LOCATION",
                format!("The {name} must be a number from -{limit} to {limit}."),
            )
        })
}

fn cache_slot(lat: f64, lon: f64) -> (i32, i32) {
    ((lat * 100.0).round() as i32, (lon * 100.0).round() as i32)
}

fn iso(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// HTTP Expires → (fresh until, RFC 3339 text), kept between 1 minute and 6 hours from now.
/// Missing or unreadable means 30 minutes.
fn freshness(expires: Option<&str>, now: SystemTime) -> (SystemTime, String) {
    let until = expires
        .and_then(|text| chrono::DateTime::parse_from_rfc2822(text.trim()).ok())
        .map(SystemTime::from)
        .map_or(now + FRESH_DEFAULT, |t| t.clamp(now + FRESH_MIN, now + FRESH_MAX));
    (until, iso(until))
}

/// Last-Modified is echoed back verbatim in If-Modified-Since, so keep it plain and short.
fn header_date(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|b| (b' '..=b'~').contains(&b))
}

fn valid_symbol(code: &str) -> bool {
    !code.is_empty() && code.len() <= 48 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// The current hour of a Locationforecast compact document: only the fields the City uses.
fn parse_met(doc: &Value, lat: f64, lon: f64, expires: &str) -> Result<Value, Failure> {
    let first = doc
        .pointer("/properties/timeseries/0/data")
        .filter(|v| v.is_object())
        .ok_or_else(|| {
            fail(
                MET.bad,
                "MET Norway's forecast had no current conditions.",
            )
        })?;
    let details = first.pointer("/instant/details");
    let number = |key: &str| {
        details
            .and_then(|d| d.get(key))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
    };
    let symbol = ["next_1_hours", "next_6_hours"].iter().find_map(|period| {
        first
            .get(*period)?
            .pointer("/summary/symbol_code")?
            .as_str()
            .filter(|code| valid_symbol(code))
            .map(str::to_owned)
    });
    let precipitation = first
        .pointer("/next_1_hours/details/precipitation_amount")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(0.0);
    let updated = doc
        .pointer("/properties/meta/updated_at")
        .and_then(Value::as_str)
        .filter(|text| text.len() <= 40 && text.bytes().all(|b| b.is_ascii_graphic()));
    Ok(json!({
        "symbol_code": symbol,
        "air_temperature": number("air_temperature"),
        "wind_speed": number("wind_speed"),
        "cloud_area_fraction": number("cloud_area_fraction"),
        "precipitation_amount": precipitation,
        "updated_at": updated,
        "expires": expires,
        "lat": lat,
        "lon": lon,
    }))
}

#[derive(Clone)]
struct MetEntry {
    data: Value,
    fresh_until: SystemTime,
    last_modified: Option<String>,
    stored: Instant,
}

fn met_cache() -> &'static Mutex<HashMap<(i32, i32), MetEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<(i32, i32), MetEntry>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn remember_met(slot: (i32, i32), entry: MetEntry) {
    let Ok(mut cache) = met_cache().lock() else {
        return;
    };
    if cache.len() >= MET_CACHE_LIMIT && !cache.contains_key(&slot) {
        let now = SystemTime::now();
        cache.retain(|_, e| e.fresh_until > now);
        if cache.len() >= MET_CACHE_LIMIT
            && let Some(oldest) = cache.iter().min_by_key(|(_, e)| e.stored).map(|(k, _)| *k)
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(slot, entry);
}

async fn current(lat: &Value, lon: &Value) -> Result<Value, Failure> {
    let lat = coordinate(lat, 90.0, "latitude")?;
    let lon = coordinate(lon, 180.0, "longitude")?;
    let slot = cache_slot(lat, lon);
    let cached = met_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&slot).cloned());
    if let Some(entry) = &cached
        && SystemTime::now() < entry.fresh_until
    {
        return Ok(entry.data.clone());
    }
    let mut request = client(&MET)?
        .get(MET_URL)
        .query(&[("lat", format!("{lat:.2}")), ("lon", format!("{lon:.2}"))])
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(since) = cached.as_ref().and_then(|e| e.last_modified.as_deref()) {
        request = request.header(reqwest::header::IF_MODIFIED_SINCE, since);
    }
    let response = request.send().await.map_err(|e| unreached(&MET, e))?;
    let status = response.status();
    let header = |name: reqwest::header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let (fresh_until, expires) = freshness(
        header(reqwest::header::EXPIRES).as_deref(),
        SystemTime::now(),
    );
    let last_modified = header(reqwest::header::LAST_MODIFIED).filter(|v| header_date(v));
    match status.as_u16() {
        200 => {}
        203 => eprintln!(
            "CodaClauda weather: MET Norway marked Locationforecast 2.0 as deprecated (HTTP 203)."
        ),
        304 => {
            let Some(mut entry) = cached else {
                return Err(fail(
                    MET.bad,
                    "MET Norway answered \"not modified\" for weather this app has not cached.",
                ));
            };
            entry.data["expires"] = json!(expires);
            entry.fresh_until = fresh_until;
            entry.last_modified = last_modified.or(entry.last_modified);
            remember_met(slot, entry.clone());
            return Ok(entry.data);
        }
        429 => {
            return Err(fail(
                "WEATHER_RATE_LIMITED",
                "MET Norway asked CodaClauda to slow down (HTTP 429). Live weather will try again later.",
            ));
        }
        403 => {
            return Err(fail(
                "WEATHER_FORBIDDEN",
                "MET Norway refused the request (HTTP 403). Live weather will try again later.",
            ));
        }
        _ => {
            return Err(fail(
                MET.unavailable,
                format!("MET Norway answered with HTTP {status}."),
            ));
        }
    }
    let body = read_limited(response, MET_BODY_LIMIT, &MET).await?;
    let doc: Value = serde_json::from_slice(&body)
        .map_err(|_| fail(MET.bad, "MET Norway returned invalid JSON."))?;
    let data = parse_met(&doc, lat, lon, &expires)?;
    remember_met(
        slot,
        MetEntry {
            data: data.clone(),
            fresh_until,
            last_modified,
            stored: Instant::now(),
        },
    );
    Ok(data)
}

/// Current weather at about 1 km: { symbol_code, air_temperature, wind_speed,
/// cloud_area_fraction, precipitation_amount, updated_at, expires, lat, lon }.
#[tauri::command]
pub(crate) async fn weather_now(lat: Value, lon: Value) -> Value {
    match current(&lat, &lon).await {
        Ok(data) => ok(data),
        Err((code, message)) => error(code, message),
    }
}

/// A searched place name: trimmed, 2-100 characters, no control characters.
fn clean_query(query: &str) -> Result<String, Failure> {
    let query = query.trim();
    if query.chars().any(char::is_control) {
        return Err(fail(
            "GEOCODE_INVALID_QUERY",
            "A place name cannot contain control characters.",
        ));
    }
    if !(QUERY_MIN..=QUERY_MAX).contains(&query.chars().count()) {
        return Err(fail(
            "GEOCODE_INVALID_QUERY",
            "Enter 2 to 100 characters to search for a place.",
        ));
    }
    Ok(query.to_owned())
}

/// Accept-Language from the system's language tag (as the WebView reports it), else English.
fn accept_language(tag: Option<&str>) -> String {
    let tag = tag.map(str::trim).unwrap_or_default();
    let valid = (2..=35).contains(&tag.len())
        && tag.as_bytes()[0].is_ascii_alphabetic()
        && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !valid {
        "en".to_owned()
    } else if tag.eq_ignore_ascii_case("en") {
        tag.to_owned()
    } else {
        format!("{tag}, en;q=0.8")
    }
}

/// Plain text: control characters dropped, at most `limit` characters, trimmed.
fn plain(value: Option<&Value>, limit: usize) -> Option<String> {
    let text: String = value?
        .as_str()?
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect();
    Some(text.trim().to_owned())
}

/// One Nominatim jsonv2 result → { name, display_name, lat, lon } (2-decimal coordinates).
fn place(item: &Value) -> Option<Value> {
    let degrees = |key: &str, limit: f64| {
        let value = item.get(key)?;
        let n = match value.as_str() {
            Some(text) => text.trim().parse::<f64>().ok()?,
            None => value.as_f64()?,
        };
        (n.is_finite() && n.abs() <= limit).then(|| round2(n))
    };
    let lat = degrees("lat", 90.0)?;
    let lon = degrees("lon", 180.0)?;
    let display = plain(item.get("display_name"), DISPLAY_LIMIT).filter(|s| !s.is_empty());
    let name = plain(item.get("name"), NAME_LIMIT)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let first = display.as_deref()?.split(',').next()?.trim();
            (!first.is_empty()).then(|| first.chars().take(NAME_LIMIT).collect())
        })?;
    let display = display.unwrap_or_else(|| name.clone());
    Some(json!({"name": name, "display_name": display, "lat": lat, "lon": lon}))
}

fn parse_places(doc: &Value) -> Result<Vec<Value>, Failure> {
    let list = doc.as_array().ok_or_else(|| {
        fail(
            NOMINATIM.bad,
            "OpenStreetMap place search returned an unexpected answer.",
        )
    })?;
    Ok(list.iter().filter_map(place).take(PLACE_LIMIT).collect())
}

fn places_cache() -> &'static Mutex<HashMap<String, (Instant, Vec<Value>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<Value>)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Nominatim's usage policy: at most one request per second, from the whole process.
async fn pace() {
    static LAST: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    let mut last = LAST.get_or_init(Default::default).lock().await;
    if let Some(previous) = *last {
        let next = previous + NOMINATIM_GAP;
        let now = Instant::now();
        if next > now {
            tokio::time::sleep(next - now).await;
        }
    }
    *last = Some(Instant::now());
}

async fn search(query: &str, language: Option<&str>) -> Result<Value, Failure> {
    let query = clean_query(query)?;
    let language = accept_language(language);
    let slot = format!("{language}\n{}", query.to_lowercase());
    let hit = places_cache().lock().ok().and_then(|cache| {
        cache
            .get(&slot)
            .filter(|(at, _)| at.elapsed() < PLACES_CACHE_TTL)
            .map(|(_, places)| places.clone())
    });
    if let Some(hit) = hit {
        return Ok(json!(hit));
    }
    let client = client(&NOMINATIM)?;
    pace().await;
    let response = client
        .get(NOMINATIM_URL)
        .query(&[("format", "jsonv2"), ("limit", "5"), ("q", query.as_str())])
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ACCEPT_LANGUAGE, language)
        .send()
        .await
        .map_err(|e| unreached(&NOMINATIM, e))?;
    let status = response.status();
    match status.as_u16() {
        200 => {}
        429 => {
            return Err(fail(
                "GEOCODE_RATE_LIMITED",
                "OpenStreetMap place search asked CodaClauda to slow down (HTTP 429). Try again in a minute.",
            ));
        }
        403 => {
            return Err(fail(
                "GEOCODE_FORBIDDEN",
                "OpenStreetMap place search refused the request (HTTP 403).",
            ));
        }
        _ => {
            return Err(fail(
                NOMINATIM.unavailable,
                format!("OpenStreetMap place search answered with HTTP {status}."),
            ));
        }
    }
    let body = read_limited(response, PLACES_BODY_LIMIT, &NOMINATIM).await?;
    let doc: Value = serde_json::from_slice(&body).map_err(|_| {
        fail(
            NOMINATIM.bad,
            "OpenStreetMap place search returned invalid JSON.",
        )
    })?;
    let places = parse_places(&doc)?;
    if let Ok(mut cache) = places_cache().lock() {
        if cache.len() >= PLACES_CACHE_LIMIT {
            cache.retain(|_, (at, _)| at.elapsed() < PLACES_CACHE_TTL);
            if cache.len() >= PLACES_CACHE_LIMIT {
                cache.clear();
            }
        }
        cache.insert(slot, (Instant::now(), places.clone()));
    }
    Ok(json!(places))
}

/// Explicit place search (never per keystroke) → [{ name, display_name, lat, lon }], at most 5.
/// `language` is the system language tag the WebView reports; it only sets Accept-Language.
#[tauri::command]
pub(crate) async fn geocode_place(query: String, language: Option<String>) -> Value {
    match search(&query, language.as_deref()).await {
        Ok(data) => ok(data),
        Err((code, message)) => error(code, message),
    }
}

#[cfg(test)]
mod tests {
    //! The sample documents are hand-written in the services' documented response formats
    //! (no network): they are not recorded MET or Nominatim answers.
    use super::*;

    const MET_SAMPLE: &str = include_str!("../testdata/weather/met-compact-sample.json");
    const PLACES_SAMPLE: &str = include_str!("../testdata/weather/nominatim-search-sample.json");

    fn met_doc() -> Value {
        serde_json::from_str(MET_SAMPLE).unwrap()
    }

    #[test]
    fn parses_the_current_hour_of_a_compact_forecast() {
        let data = parse_met(&met_doc(), 59.91, 10.75, "2026-10-16T11:31:02Z").unwrap();
        assert_eq!(data["symbol_code"], "lightrain");
        assert_eq!(data["air_temperature"], 8.6);
        assert_eq!(data["wind_speed"], 6.3);
        assert_eq!(data["cloud_area_fraction"], 96.1);
        assert_eq!(data["precipitation_amount"], 0.4);
        assert_eq!(data["updated_at"], "2026-10-16T10:43:21Z");
        assert_eq!(data["expires"], "2026-10-16T11:31:02Z");
        assert_eq!(data["lat"], 59.91);
        assert_eq!(data["lon"], 10.75);
        let keys: Vec<&str> = data.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 9, "only the documented fields are returned: {keys:?}");
    }

    #[test]
    fn symbol_falls_back_to_the_six_hour_summary() {
        let mut doc = met_doc();
        doc["properties"]["timeseries"][0]["data"]
            .as_object_mut()
            .unwrap()
            .remove("next_1_hours");
        let data = parse_met(&doc, 1.0, 2.0, "x").unwrap();
        assert_eq!(data["symbol_code"], "rain");
        assert_eq!(data["precipitation_amount"], 0.0);
    }

    #[test]
    fn missing_or_odd_fields_stay_null() {
        let mut doc = met_doc();
        let first = &mut doc["properties"]["timeseries"][0]["data"];
        first["next_1_hours"]["summary"]["symbol_code"] = json!("<script>");
        first["next_6_hours"]["summary"]["symbol_code"] = json!(42);
        first["instant"]["details"]["air_temperature"] = json!("warm");
        let data = parse_met(&doc, 1.0, 2.0, "x").unwrap();
        assert!(data["symbol_code"].is_null());
        assert!(data["air_temperature"].is_null());
        assert_eq!(data["wind_speed"], 6.3);
    }

    #[test]
    fn a_forecast_without_timeseries_is_a_bad_response() {
        let doc = json!({"properties": {"timeseries": []}});
        assert_eq!(parse_met(&doc, 0.0, 0.0, "x").unwrap_err().0, "WEATHER_BAD_RESPONSE");
    }

    #[test]
    fn coordinates_are_rounded_to_two_decimals() {
        assert_eq!(coordinate(&json!(59.913868), 90.0, "latitude").unwrap(), 59.91);
        assert_eq!(coordinate(&json!(10.7522454), 180.0, "longitude").unwrap(), 10.75);
        assert_eq!(coordinate(&json!(-104.9849), 180.0, "longitude").unwrap(), -104.98);
        assert_eq!(coordinate(&json!(90), 90.0, "latitude").unwrap(), 90.0);
        let tiny = coordinate(&json!(-0.004), 90.0, "latitude").unwrap();
        assert!(tiny == 0.0 && tiny.is_sign_positive(), "no -0.00 in a request");
        assert_eq!(format!("{:.2}", round2(-0.001)), "0.00");
        assert_eq!(cache_slot(59.91, 10.75), cache_slot(round2(59.9112), round2(10.7499)));
    }

    #[test]
    fn invalid_coordinates_are_refused() {
        for (value, limit) in [
            (json!(90.5), 90.0),
            (json!(-91), 90.0),
            (json!(180.01), 180.0),
            (json!(null), 90.0),
            (json!("12.5"), 90.0),
            (json!([1]), 180.0),
        ] {
            let error = coordinate(&value, limit, "latitude").unwrap_err();
            assert_eq!(error.0, "WEATHER_INVALID_LOCATION", "{value}");
        }
    }

    #[test]
    fn expires_sets_the_cache_lifetime_within_bounds() {
        let now = SystemTime::from(chrono::DateTime::parse_from_rfc3339("2026-10-16T12:00:00Z").unwrap());
        let (until, text) = freshness(Some("Fri, 16 Oct 2026 12:31:02 GMT"), now);
        assert_eq!(text, "2026-10-16T12:31:02Z");
        assert_eq!(until, now + Duration::from_secs(31 * 60 + 2));
        assert_eq!(freshness(None, now).0, now + FRESH_DEFAULT);
        assert_eq!(freshness(Some("soon"), now).0, now + FRESH_DEFAULT);
        assert_eq!(freshness(Some("Fri, 16 Oct 2026 11:00:00 GMT"), now).0, now + FRESH_MIN);
        assert_eq!(freshness(Some("Sat, 17 Oct 2026 12:00:00 GMT"), now).0, now + FRESH_MAX);
    }

    #[test]
    fn last_modified_must_be_plain_text() {
        assert!(header_date("Fri, 16 Oct 2026 10:43:21 GMT"));
        assert!(!header_date(""));
        assert!(!header_date("Fri\r\nX-Injected: 1"));
        assert!(!header_date(&"x".repeat(65)));
    }

    #[test]
    fn place_queries_are_validated() {
        assert_eq!(clean_query("  Oslo \n").unwrap(), "Oslo");
        assert_eq!(clean_query("Ås").unwrap(), "Ås");
        assert_eq!(clean_query(&"é".repeat(100)).unwrap().chars().count(), 100);
        let long = "x".repeat(101);
        for bad in ["", " a ", "Os\u{7}lo", "Oslo\tNorway", long.as_str()] {
            assert_eq!(clean_query(bad).unwrap_err().0, "GEOCODE_INVALID_QUERY", "{bad:?}");
        }
    }

    #[test]
    fn places_are_parsed_rounded_and_capped() {
        let doc: Value = serde_json::from_str(PLACES_SAMPLE).unwrap();
        let places = parse_places(&doc).unwrap();
        assert_eq!(places.len(), PLACE_LIMIT);
        assert_eq!(
            places[0],
            json!({"name": "Denver", "display_name": "Denver, Colorado, United States", "lat": 39.74, "lon": -104.98})
        );
        // An empty name falls back to the first part of the display name.
        assert_eq!(places[1]["name"], "Sydney");
        assert_eq!(places[1]["lat"], -33.87);
        // Unparsable or out-of-range coordinates are skipped.
        assert!(places.iter().all(|p| p["name"] != "Broken" && p["name"] != "Too far north"));
        // Control characters never reach the UI.
        assert_eq!(places[2]["display_name"], "Oslo, Norway");
        assert!(parse_places(&json!({"error": "x"})).is_err());
    }

    #[test]
    fn accept_language_uses_the_system_tag_or_english() {
        assert_eq!(accept_language(Some("nb-NO")), "nb-NO, en;q=0.8");
        assert_eq!(accept_language(Some("en")), "en");
        assert_eq!(accept_language(None), "en");
        assert_eq!(accept_language(Some("x;rm -rf")), "en");
        assert_eq!(accept_language(Some("-en")), "en");
    }

    #[test]
    fn user_agent_identifies_the_app() {
        let agent = user_agent();
        assert!(agent.starts_with("CodaClauda/"));
        assert!(agent.ends_with(" github.com/delores88/codaclauda"));
    }

    #[test]
    fn symbol_codes_are_plain_lowercase() {
        assert!(valid_symbol("lightrainshowersandthunder_polartwilight"));
        assert!(!valid_symbol("Rain"));
        assert!(!valid_symbol(""));
        assert!(!valid_symbol("rain<b>"));
    }
}
