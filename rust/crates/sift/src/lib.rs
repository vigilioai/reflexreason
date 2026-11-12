//! sift: turn a raw log tail into a handful of counted templates and a
//! stable incident fingerprint. No dependencies, no allocation per repeated
//! line.
//!
//! The TypeScript twin lives in ts/src/intake/sift.ts and must produce the
//! same output byte for byte; scripts/check-twins.sh enforces that.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template<'a> {
    pub pattern: String,
    pub count: u32,
    pub level: u8,
    pub first: u32,
    pub sample: &'a str,
}

#[derive(Debug, Default)]
pub struct Distilled<'a> {
    pub lines: u32,
    pub bytes: usize,
    pub templates: Vec<Template<'a>>,
}

const LEVEL3: [&str; 5] = ["fatal", "panic", "oom", "killed", "segfault"];
const LEVEL2: [&str; 7] = [
    "error",
    "exception",
    "refused",
    "timeout",
    "timed out",
    "denied",
    "failed",
];
const LEVEL1: [&str; 5] = ["warn", "gap", "stale", "retry", "backoff"];

/// Severity of a template, from keywords in its already-lowercased pattern.
pub fn level(lower: &str) -> u8 {
    if LEVEL3.iter().any(|k| lower.contains(k)) {
        3
    } else if LEVEL2.iter().any(|k| lower.contains(k)) {
        2
    } else if LEVEL1.iter().any(|k| lower.contains(k)) {
        1
    } else {
        0
    }
}

/// Replace the variable parts of a line with `<*>` so repeated lines
/// collapse. A token that contains a digit is a variable; `key=value` keeps
/// its key.
pub fn mask_into(line: &str, out: &mut String) {
    out.clear();
    for tok in line.split_ascii_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        if !tok.bytes().any(|b| b.is_ascii_digit()) {
            out.push_str(tok);
            continue;
        }
        match tok.find('=') {
            Some(p)
                if p > 0
                    && !tok[..p].bytes().any(|b| b.is_ascii_digit()) =>
            {
                out.push_str(&tok[..=p]);
                out.push_str("<*>");
            }
            _ => out.push_str("<*>"),
        }
    }
}

/// Count templates over the whole log, then keep the `top_k` most useful:
/// highest severity first, then most frequent, then earliest.
pub fn distill(log: &str, top_k: usize) -> Distilled<'_> {
    let mut index: HashMap<String, usize> = HashMap::with_capacity(64);
    let mut all: Vec<Template<'_>> = Vec::with_capacity(64);
    let mut buf = String::with_capacity(256);
    let mut lines = 0u32;

    for raw in log.split('\n') {
        mask_into(raw, &mut buf);
        if buf.is_empty() {
            continue;
        }
        if let Some(&i) = index.get(buf.as_str()) {
            all[i].count += 1;
        } else {
            index.insert(buf.clone(), all.len());
            all.push(Template {
                level: level(&buf.to_ascii_lowercase()),
                pattern: buf.clone(),
                count: 1,
                first: lines,
                sample: raw.trim_matches(|c: char| c.is_ascii_whitespace()),
            });
        }
        lines += 1;
    }

    all.sort_by(|a, b| {
        b.level
            .cmp(&a.level)
            .then(b.count.cmp(&a.count))
            .then(a.first.cmp(&b.first))
    });
    all.truncate(top_k);
    Distilled { lines, bytes: log.len(), templates: all }
}

/// FNV-1a, 64 bit. Stable across processes and languages, which a lease key
/// shared by Rust and TypeScript workers needs; `DefaultHasher` is neither.
pub fn fnv1a64(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Same fault on the same workload gives the same fingerprint, whatever the
/// pod name, timestamps or sequence numbers were.
pub fn fingerprint(
    namespace: &str,
    workload: &str,
    reason: &str,
    top_pattern: &str,
) -> String {
    let joined = format!("{namespace}/{workload}/{reason}/{top_pattern}");
    format!("{:016x}", fnv1a64(joined.as_bytes()))
}

/// First `max` characters of `s`, cut on a character boundary.
pub fn clip(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_numbers_and_keeps_keys() {
        let mut out = String::new();
        mask_into(
            "08:59:50.123 md tick seq=4411 sym=TXF px=17250.5 ok",
            &mut out,
        );
        assert_eq!(out, "<*> md tick seq=<*> sym=TXF px=<*> ok");
    }

    #[test]
    fn collapses_repeats_and_ranks_by_severity() {
        let mut log = String::new();
        for i in 0..500 {
            log.push_str(&format!("t={i} md tick seq={i} px=17250\n"));
        }
        log.push_str("t=501 FATAL config: FEED_URL is empty\n");
        log.push_str("t=502 WARN feed heartbeat gap 5200ms\n");
        let d = distill(&log, 8);
        assert_eq!(d.lines, 502);
        assert_eq!(d.templates.len(), 3);
        assert_eq!(d.templates[0].level, 3);
        assert_eq!(
            d.templates[0].pattern,
            "t=<*> FATAL config: FEED_URL is empty"
        );
        assert_eq!(d.templates[1].level, 1);
        assert_eq!(d.templates[2].count, 500);
    }

    #[test]
    fn fingerprint_ignores_pod_identity() {
        let a = fingerprint(
            "trading",
            "feed-handler",
            "CrashLoopBackOff",
            "FATAL x",
        );
        let b = fingerprint(
            "trading",
            "feed-handler",
            "CrashLoopBackOff",
            "FATAL x",
        );
        let c = fingerprint(
            "trading",
            "order-gateway",
            "CrashLoopBackOff",
            "FATAL x",
        );
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn fnv_matches_published_vector() {
        // Test vector from the FNV reference: "a" hashes to
        // af63dc4c8601ec8c.
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn clip_respects_utf8() {
        assert_eq!(clip("價格abc", 2), "價格");
        assert_eq!(clip("abc", 10), "abc");
    }
}
