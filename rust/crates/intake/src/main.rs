//! intake: the front door for an alert storm.
//!
//!   intake < event.json            one event on stdin, one result on stdout
//!   intake --bench N < event.json  run the same event N times, print timings
//!   (AWS Lambda)                   starts the Lambda runtime loop when the
//!                                  AWS_LAMBDA_RUNTIME_API variable is present
//!
//! Tokio is only started in Lambda mode, so the CLI path stays a plain
//! single-threaded program with nothing to initialise.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::time::Instant;

#[derive(Deserialize)]
struct Event {
    namespace: String,
    workload: String,
    reason: String,
    log: String,
    #[serde(default)]
    top_k: Option<usize>,
}

#[derive(Serialize)]
struct TemplateOut<'a> {
    pattern: &'a str,
    count: u32,
    level: u8,
    sample: &'a str,
}

#[derive(Serialize)]
struct Out<'a> {
    fingerprint: String,
    key: String,
    lines: u32,
    bytes: usize,
    templates: Vec<TemplateOut<'a>>,
}

const SAMPLE_CHARS: usize = 240;

fn process(ev: &Event) -> String {
    let d = sift::distill(&ev.log, ev.top_k.unwrap_or(8));
    let top = d.templates.first().map(|t| t.pattern.as_str()).unwrap_or("");
    let out = Out {
        fingerprint: sift::fingerprint(
            &ev.namespace,
            &ev.workload,
            &ev.reason,
            top,
        ),
        key: format!("{}/{}", ev.namespace, ev.workload),
        lines: d.lines,
        bytes: d.bytes,
        templates: d
            .templates
            .iter()
            .map(|t| TemplateOut {
                pattern: &t.pattern,
                count: t.count,
                level: t.level,
                sample: sift::clip(t.sample, SAMPLE_CHARS),
            })
            .collect(),
    };
    serde_json::to_string(&out).expect("output is always serialisable")
}

/// A direct invoke carries the event itself; an SQS trigger wraps events in
/// `Records[].body`. Accept both so one binary serves both wirings.
fn handle(payload: Value) -> Result<Value, String> {
    if let Some(records) = payload.get("Records").and_then(Value::as_array)
    {
        let mut results = Vec::with_capacity(records.len());
        for r in records {
            let body = r
                .get("body")
                .and_then(Value::as_str)
                .ok_or("record without body")?;
            let ev: Event =
                serde_json::from_str(body).map_err(|e| e.to_string())?;
            results.push(
                serde_json::from_str::<Value>(&process(&ev))
                    .map_err(|e| e.to_string())?,
            );
        }
        return Ok(Value::Array(results));
    }
    let ev: Event =
        serde_json::from_value(payload).map_err(|e| e.to_string())?;
    serde_json::from_str(&process(&ev)).map_err(|e| e.to_string())
}

fn lambda_main() {
    use lambda_runtime::{service_fn, Error, LambdaEvent};
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let result: Result<(), Error> = rt.block_on(lambda_runtime::run(
        service_fn(|e: LambdaEvent<Value>| async move {
            handle(e.payload).map_err(Error::from)
        }),
    ));
    if let Err(e) = result {
        eprintln!("lambda runtime stopped: {e}");
        std::process::exit(1);
    }
}

fn main() {
    if std::env::var_os("AWS_LAMBDA_RUNTIME_API").is_some() {
        return lambda_main();
    }
    let args: Vec<String> = std::env::args().collect();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("read stdin");
    let ev: Event = match serde_json::from_str(&input) {
        Ok(ev) => ev,
        Err(e) => {
            eprintln!("bad event: {e}");
            std::process::exit(2);
        }
    };

    if args.get(1).map(String::as_str) == Some("--bench") {
        let n: u32 =
            args.get(2).and_then(|s| s.parse().ok()).unwrap_or(200);
        let mut samples = Vec::with_capacity(n as usize);
        let mut sink = 0usize;
        for _ in 0..n {
            let t = Instant::now();
            sink += process(&ev).len();
            samples.push(t.elapsed().as_nanos() as u64);
        }
        samples.sort_unstable();
        let p = |q: f64| samples[((samples.len() - 1) as f64 * q) as usize];
        let mean =
            samples.iter().sum::<u64>() as f64 / samples.len() as f64;
        println!(
            "{{\"impl\":\"rust\",\"runs\":{n},\"bytes\":{},\"p50_ns\":{},\"p99_ns\":{},\"mean_ns\":{:.0},\"mb_per_s\":{:.1},\"sink\":{sink}}}",
            ev.log.len(),
            p(0.5),
            p(0.99),
            mean,
            ev.log.len() as f64 / 1e6 / (mean / 1e9)
        );
        return;
    }

    let out = process(&ev);
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(out.as_bytes()).expect("write stdout");
    stdout.write_all(b"\n").expect("write stdout");
}
