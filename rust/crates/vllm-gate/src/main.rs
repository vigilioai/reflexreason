//! vllm-gate: a small gateway that sits in front of vLLM and makes agent
//! traffic cheaper for it.
//!
//!   1. Canonical requests. Tools are sorted by name and every JSON object is
//!      written with sorted keys, so two requests that mean the same thing
//!      render to the same prompt tokens and vLLM's prefix cache can reuse them.
//!   2. Exact cache. A deterministic request (temperature 0, no streaming)
//!      that was answered in the last TTL is answered from memory.
//!   3. Single flight. N identical requests arriving together cost one
//!      upstream call; the others wait for its result.
//!   4. Admission control. At most GATE_MAX_INFLIGHT requests reach vLLM at
//!      once, so a swarm cannot push a 12 GB card past its batch limit.
//!   5. Prefix accounting. For each session the gate measures how many leading
//!      bytes of the prompt repeat the previous turn, before and after
//!      canonicalisation. That number predicts prefix-cache reuse without a GPU.
//!
//! Everything else (GET /v1/models, /metrics, /health) is passed through.

use axum::serve::ListenerExt;
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    routing::{get, post},
    Router,
};
use futures_util::StreamExt;
use serde_json::Value;
use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::BuildHasher,
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};

#[derive(Default)]
struct Metrics {
    requests: AtomicU64,
    cache_hits: AtomicU64,
    coalesced: AtomicU64,
    passed: AtomicU64,
    upstream_calls: AtomicU64,
    upstream_errors: AtomicU64,
    upstream_us: AtomicU64,
    queue_us: AtomicU64,
    gate_us: AtomicU64,
    prompt_bytes: AtomicU64,
    shared_raw: AtomicU64,
    shared_canonical: AtomicU64,
}

struct Reply {
    status: StatusCode,
    content_type: Option<HeaderValue>,
    body: Bytes,
}

type Flight = watch::Receiver<Option<Arc<Reply>>>;

struct Gate {
    upstream: String,
    http: reqwest::Client,
    permits: Arc<Semaphore>,
    ttl: Duration,
    cache_max: usize,
    cache: Mutex<HashMap<u64, (Instant, Arc<Reply>)>>,
    inflight: Mutex<HashMap<u64, Flight>>,
    last_prompt: Mutex<HashMap<u64, (Vec<u8>, Vec<u8>)>>,
    /// SipHash with a key drawn at start-up. Cache keys only have to be
    /// stable inside one process, and a keyed hash means that nobody
    /// outside can construct two requests that share a key.
    keys: RandomState,
    m: Metrics,
}

fn fnv1a64(data: &[u8]) -> u64 {
    data.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn tool_name(tool: &Value) -> &str {
    tool.pointer("/function/name").and_then(Value::as_str).unwrap_or("")
}

/// Make semantically equal requests byte-equal: tools in name order, keys
/// sorted.
fn canonicalize(v: &mut Value) {
    if let Some(tools) = v.get_mut("tools").and_then(Value::as_array_mut) {
        tools.sort_by(|a, b| tool_name(a).cmp(tool_name(b)));
    }
    v.sort_all_objects();
}

/// The part of the request a chat template turns into prompt text, in the
/// order templates emit it: tool definitions first, then the messages.
fn prompt_bytes(v: &Value) -> Vec<u8> {
    let mut out = Vec::with_capacity(4096);
    for key in ["tools", "messages"] {
        if let Some(part) = v.get(key) {
            serde_json::to_writer(&mut out, part)
                .expect("writing to a Vec cannot fail");
        }
    }
    out
}

fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

/// Callers may name the session; otherwise the system prompt identifies it.
fn session_key(headers: &HeaderMap, v: &Value) -> u64 {
    if let Some(id) = headers.get("x-session-id") {
        return fnv1a64(id.as_bytes());
    }
    let first = v
        .pointer("/messages/0/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    fnv1a64(first.as_bytes())
}

/// Only a request that must give the same answer twice may be cached.
fn cacheable(v: &Value) -> bool {
    let streaming =
        v.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let greedy = v.get("temperature").and_then(Value::as_f64) == Some(0.0);
    greedy && !streaming
}

impl Gate {
    /// Record this turn's prompt and return how many leading bytes it
    /// shares with the session's previous turn: (raw, canonical, canonical
    /// length).
    fn track_prefix(
        &self,
        session: u64,
        raw: Vec<u8>,
        canonical: Vec<u8>,
    ) -> (usize, usize, usize) {
        let mut last = self.last_prompt.lock().unwrap();
        if last.len() > 4096 {
            last.clear();
        }
        let total = canonical.len();
        let shared = match last.get(&session) {
            Some((prev_raw, prev_canon)) => {
                let s = (
                    common_prefix(prev_raw, &raw),
                    common_prefix(prev_canon, &canonical),
                );
                self.m.prompt_bytes.fetch_add(total as u64, Relaxed);
                self.m.shared_raw.fetch_add(s.0 as u64, Relaxed);
                self.m.shared_canonical.fetch_add(s.1 as u64, Relaxed);
                s
            }
            None => (0, 0),
        };
        last.insert(session, (raw, canonical));
        (shared.0, shared.1, total)
    }

    fn cache_get(&self, key: u64) -> Option<Arc<Reply>> {
        let cache = self.cache.lock().unwrap();
        cache
            .get(&key)
            .filter(|(at, _)| at.elapsed() < self.ttl)
            .map(|(_, r)| r.clone())
    }

    fn cache_put(&self, key: u64, reply: Arc<Reply>) {
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= self.cache_max {
            let ttl = self.ttl;
            cache.retain(|_, (at, _)| at.elapsed() < ttl);
            if cache.len() >= self.cache_max {
                cache.clear();
            }
        }
        cache.insert(key, (Instant::now(), reply));
    }

    async fn call_upstream(
        &self,
        body: Vec<u8>,
        auth: Option<HeaderValue>,
    ) -> Reply {
        let waited = Instant::now();
        let _permit = self
            .permits
            .acquire()
            .await
            .expect("semaphore is never closed");
        self.m
            .queue_us
            .fetch_add(waited.elapsed().as_micros() as u64, Relaxed);
        self.m.upstream_calls.fetch_add(1, Relaxed);

        let started = Instant::now();
        let mut req = self
            .http
            .post(format!("{}/v1/chat/completions", self.upstream))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(a) = auth {
            req = req.header(header::AUTHORIZATION, a);
        }
        let reply = match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                let content_type =
                    resp.headers().get(header::CONTENT_TYPE).cloned();
                match resp.bytes().await {
                    Ok(body) => Reply { status, content_type, body },
                    Err(e) => bad_gateway(&e.to_string()),
                }
            }
            Err(e) => bad_gateway(&e.to_string()),
        };
        self.m
            .upstream_us
            .fetch_add(started.elapsed().as_micros() as u64, Relaxed);
        if !reply.status.is_success() {
            self.m.upstream_errors.fetch_add(1, Relaxed);
        }
        reply
    }
}

fn bad_gateway(why: &str) -> Reply {
    let body = serde_json::json!({ "error": { "message": why, "type": "gate_upstream_error" } });
    Reply {
        status: StatusCode::BAD_GATEWAY,
        content_type: Some(HeaderValue::from_static("application/json")),
        body: Bytes::from(body.to_string()),
    }
}

fn respond(reply: &Reply, outcome: &'static str, prefix: &str) -> Response {
    let mut res = Response::new(Body::from(reply.body.clone()));
    *res.status_mut() = reply.status;
    let h = res.headers_mut();
    if let Some(ct) = &reply.content_type {
        h.insert(header::CONTENT_TYPE, ct.clone());
    }
    h.insert("x-gate", HeaderValue::from_static(outcome));
    if let Ok(v) = HeaderValue::from_str(prefix) {
        h.insert("x-gate-prefix", v);
    }
    res
}

async fn chat(
    State(g): State<Arc<Gate>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let entered = Instant::now();
    g.m.requests.fetch_add(1, Relaxed);
    let auth = headers.get(header::AUTHORIZATION).cloned();

    // Not JSON: nothing to canonicalise, let vLLM produce the error.
    let Ok(mut v) = serde_json::from_slice::<Value>(&body) else {
        g.m.passed.fetch_add(1, Relaxed);
        return respond(
            &g.call_upstream(body.to_vec(), auth).await,
            "pass",
            "0/0/0",
        );
    };

    let session = session_key(&headers, &v);
    let raw_prompt = prompt_bytes(&v);
    canonicalize(&mut v);
    let (raw, canon, total) =
        g.track_prefix(session, raw_prompt, prompt_bytes(&v));
    let prefix = format!("{raw}/{canon}/{total}");
    let canonical =
        serde_json::to_vec(&v).expect("a parsed value serialises");

    if !cacheable(&v) {
        g.m.passed.fetch_add(1, Relaxed);
        g.m.gate_us
            .fetch_add(entered.elapsed().as_micros() as u64, Relaxed);
        return stream_through(&g, canonical, auth, &prefix).await;
    }

    // A reply is only ever shared between callers that sent the same
    // canonical request with the same credential.
    let credential = auth.as_ref().map(|a| a.as_bytes());
    let key = g.keys.hash_one((&canonical, credential));
    if let Some(hit) = g.cache_get(key) {
        g.m.cache_hits.fetch_add(1, Relaxed);
        g.m.gate_us
            .fetch_add(entered.elapsed().as_micros() as u64, Relaxed);
        return respond(&hit, "hit", &prefix);
    }

    // Either join the flight already in the air for this key, or start one.
    // The upstream call runs in its own task: if the first caller hangs up,
    // the callers waiting behind it still get their answer.
    let (mut flight, leader) = {
        let mut inflight = g.inflight.lock().unwrap();
        match inflight.get(&key) {
            Some(rx) => (rx.clone(), false),
            None => {
                let (tx, rx) = watch::channel(None);
                inflight.insert(key, rx.clone());
                let gate = g.clone();
                tokio::spawn(async move {
                    let reply =
                        Arc::new(gate.call_upstream(canonical, auth).await);
                    if reply.status.is_success() {
                        gate.cache_put(key, reply.clone());
                    }
                    gate.inflight.lock().unwrap().remove(&key);
                    let _ = tx.send(Some(reply));
                });
                (rx, true)
            }
        }
    };
    if !leader {
        g.m.coalesced.fetch_add(1, Relaxed);
    }
    g.m.gate_us.fetch_add(entered.elapsed().as_micros() as u64, Relaxed);

    loop {
        let ready = flight.borrow().clone();
        if let Some(reply) = ready {
            return respond(
                &reply,
                if leader { "miss" } else { "coalesced" },
                &prefix,
            );
        }
        if flight.changed().await.is_err() {
            return respond(
                &bad_gateway("upstream task ended early"),
                "miss",
                &prefix,
            );
        }
    }
}

/// Streaming and sampled requests are not cached, but they still go out in
/// canonical form and still count against the admission limit. The permit
/// is held until the last byte of the stream has been relayed.
async fn stream_through(
    g: &Arc<Gate>,
    body: Vec<u8>,
    auth: Option<HeaderValue>,
    prefix: &str,
) -> Response {
    let waited = Instant::now();
    let permit = g
        .permits
        .clone()
        .acquire_owned()
        .await
        .expect("semaphore is never closed");
    g.m.queue_us.fetch_add(waited.elapsed().as_micros() as u64, Relaxed);
    g.m.upstream_calls.fetch_add(1, Relaxed);

    let mut req = g
        .http
        .post(format!("{}/v1/chat/completions", g.upstream))
        .header(header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(a) = auth {
        req = req.header(header::AUTHORIZATION, a);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let content_type =
                resp.headers().get(header::CONTENT_TYPE).cloned();
            let stream = resp.bytes_stream().map(move |chunk| {
                let _held = &permit;
                chunk
            });
            let mut res = Response::new(Body::from_stream(stream));
            *res.status_mut() = status;
            if let Some(ct) = content_type {
                res.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            res.headers_mut()
                .insert("x-gate", HeaderValue::from_static("pass"));
            if let Ok(v) = HeaderValue::from_str(prefix) {
                res.headers_mut().insert("x-gate-prefix", v);
            }
            res
        }
        Err(e) => {
            g.m.upstream_errors.fetch_add(1, Relaxed);
            respond(&bad_gateway(&e.to_string()), "pass", prefix)
        }
    }
}

/// Any other path goes to vLLM untouched.
async fn passthrough(State(g): State<Arc<Gate>>, req: Request) -> Response {
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_owned();
    let method = req.method().clone();
    let auth = req.headers().get(header::AUTHORIZATION).cloned();
    let body = axum::body::to_bytes(req.into_body(), 32 << 20)
        .await
        .unwrap_or_default();
    let mut out = g
        .http
        .request(method, format!("{}{}", g.upstream, path))
        .body(body);
    if let Some(a) = auth {
        out = out.header(header::AUTHORIZATION, a);
    }
    match out.send().await {
        Ok(resp) => {
            let status = resp.status();
            let content_type =
                resp.headers().get(header::CONTENT_TYPE).cloned();
            let mut res =
                Response::new(Body::from_stream(resp.bytes_stream()));
            *res.status_mut() = status;
            if let Some(ct) = content_type {
                res.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            res
        }
        Err(e) => respond(&bad_gateway(&e.to_string()), "pass", "0/0/0"),
    }
}

async fn metrics(State(g): State<Arc<Gate>>) -> String {
    let m = &g.m;
    let rows: [(&str, &AtomicU64); 12] = [
        ("gate_requests_total", &m.requests),
        ("gate_cache_hits_total", &m.cache_hits),
        ("gate_coalesced_total", &m.coalesced),
        ("gate_passed_total", &m.passed),
        ("gate_upstream_calls_total", &m.upstream_calls),
        ("gate_upstream_errors_total", &m.upstream_errors),
        ("gate_upstream_microseconds_total", &m.upstream_us),
        ("gate_queue_microseconds_total", &m.queue_us),
        ("gate_overhead_microseconds_total", &m.gate_us),
        ("gate_prompt_bytes_total", &m.prompt_bytes),
        ("gate_prompt_shared_raw_bytes_total", &m.shared_raw),
        ("gate_prompt_shared_canonical_bytes_total", &m.shared_canonical),
    ];
    rows.iter()
        .map(|(name, v)| format!("{name} {}\n", v.load(Relaxed)))
        .collect()
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() {
    let listen: String = env_or("GATE_LISTEN", "0.0.0.0:8080".to_owned());
    let upstream: String =
        env_or("GATE_UPSTREAM", "http://127.0.0.1:8000".to_owned());
    let gate = Arc::new(Gate {
        upstream: upstream.trim_end_matches('/').to_owned(),
        // TCP_NODELAY on both sides of the gate. Without it the first
        // benchmark showed +16 ms at the median for 22 microseconds of
        // work: headers and body went out as two small writes, Nagle's
        // algorithm held the second until the first was acknowledged, and
        // the peer delayed that ACK.
        http: reqwest::Client::builder()
            .pool_max_idle_per_host(64)
            .tcp_nodelay(true)
            .build()
            .expect("http client"),
        permits: Arc::new(Semaphore::new(env_or(
            "GATE_MAX_INFLIGHT",
            8usize,
        ))),
        ttl: Duration::from_millis(env_or("GATE_CACHE_TTL_MS", 60_000u64)),
        cache_max: env_or("GATE_CACHE_MAX", 2048usize),
        cache: Mutex::default(),
        inflight: Mutex::default(),
        last_prompt: Mutex::default(),
        keys: RandomState::new(),
        m: Metrics::default(),
    });
    let app = Router::new()
        .route("/v1/chat/completions", post(chat))
        .route("/gate/metrics", get(metrics))
        .fallback(passthrough)
        .layer(DefaultBodyLimit::max(32 << 20))
        .with_state(gate);
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .expect("bind listen address")
        .tap_io(|tcp| {
            let _ = tcp.set_nodelay(true);
        });
    if std::env::var_os("GATE_EXIT_AFTER_BIND").is_some() {
        // Start-up benchmark: everything is initialised, nothing is served.
        return;
    }
    eprintln!("vllm-gate listening on {listen}, upstream {upstream}");
    axum::serve(listener, app).await.expect("server");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(name: &str) -> Value {
        json!({ "type": "function", "function": { "name": name, "parameters": { "type": "object", "properties": {} } } })
    }

    #[test]
    fn shuffled_tools_and_keys_become_identical_bytes() {
        let mut a = json!({ "model": "m", "temperature": 0, "tools": [tool("pod_logs"), tool("pod_describe")],
                            "messages": [{ "role": "user", "content": "x" }] });
        let mut b: Value = serde_json::from_str(
            r#"{"messages":[{"content":"x","role":"user"}],"tools":[
                {"function":{"parameters":{"properties":{},"type":"object"},"name":"pod_describe"},"type":"function"},
                {"function":{"name":"pod_logs","parameters":{"type":"object","properties":{}}},"type":"function"}],
               "temperature":0,"model":"m"}"#,
        )
        .unwrap();
        assert_ne!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap()
        );
        canonicalize(&mut a);
        canonicalize(&mut b);
        assert_eq!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap()
        );
    }

    #[test]
    fn appended_turn_shares_the_whole_previous_prompt() {
        let turn1 = json!({ "messages": [{ "role": "system", "content": "s" }, { "role": "user", "content": "u1" }] });
        let turn2 = json!({ "messages": [{ "role": "system", "content": "s" }, { "role": "user", "content": "u1" },
                                         { "role": "assistant", "content": "a1" }] });
        let (p1, p2) = (prompt_bytes(&turn1), prompt_bytes(&turn2));
        // Everything but the closing bracket of the first array is reused.
        assert_eq!(common_prefix(&p1, &p2), p1.len() - 1);
    }

    #[test]
    fn a_timestamp_in_the_system_prompt_destroys_the_shared_prefix() {
        let t1 = json!({ "messages": [{ "role": "system", "content": "now 08:59:50 you are an agent" }] });
        let t2 = json!({ "messages": [{ "role": "system", "content": "now 08:59:51 you are an agent" }] });
        let shared = common_prefix(&prompt_bytes(&t1), &prompt_bytes(&t2));
        assert!(
            shared < 50,
            "only the bytes before the timestamp are shared, got {shared}"
        );
    }

    #[test]
    fn only_greedy_non_streaming_requests_are_cacheable() {
        assert!(cacheable(&json!({ "temperature": 0 })));
        assert!(cacheable(&json!({ "temperature": 0.0, "stream": false })));
        assert!(!cacheable(&json!({ "temperature": 0, "stream": true })));
        assert!(!cacheable(&json!({ "temperature": 0.7 })));
        assert!(!cacheable(&json!({})));
    }

    #[test]
    fn cache_key_depends_on_request_and_credential() {
        let keys = RandomState::new();
        let body = b"{}".to_vec();
        let other = b"{ }".to_vec();
        let one = keys.hash_one((&body, Some(&b"Bearer one"[..])));
        assert_eq!(one, keys.hash_one((&body, Some(&b"Bearer one"[..]))));
        assert_ne!(one, keys.hash_one((&body, Some(&b"Bearer two"[..]))));
        assert_ne!(one, keys.hash_one((&body, None::<&[u8]>)));
        assert_ne!(one, keys.hash_one((&other, Some(&b"Bearer one"[..]))));
    }
}
