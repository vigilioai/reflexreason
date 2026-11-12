//! rusage: run one command and report what the kernel charged it.
//!
//!   rusage --fd N <command> [args...]
//!
//! The child inherits stdin, stdout and stderr untouched. One JSON line
//! with wall time, peak resident memory and CPU time is written to file
//! descriptor N, which the caller opened.
//!
//! This exists because of an error in the first cold-start numbers. Linux
//! carries a process's peak memory across exec, so a child forked by a
//! Python script can never report less than the Python interpreter that
//! forked it. A 1 MB static binary was reported at 16 MB. This helper is
//! static and small, so the floor it passes on is its own few hundred
//! kilobytes, and running /bin/true through it measures that floor.

use std::io::Write;
use std::os::fd::FromRawFd;
use std::process::Command;
use std::time::Instant;

fn usage() -> ! {
    eprintln!("usage: rusage --fd N <command> [args...]");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 || args[0] != "--fd" {
        usage();
    }
    let fd: i32 = args[1].parse().unwrap_or_else(|_| usage());
    // The report descriptor is this program's business, not the child's.
    // SAFETY: fcntl on a descriptor number only changes a flag on it.
    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };

    let t0 = Instant::now();
    let status = Command::new(&args[2]).args(&args[3..]).status();
    let wall_us = t0.elapsed().as_micros();
    let code = match status {
        Ok(s) => s.code().unwrap_or(-1),
        Err(e) => {
            eprintln!("rusage: {}: {e}", args[2]);
            std::process::exit(127);
        }
    };

    // RUSAGE_CHILDREN covers exactly the one child that was just reaped.
    // SAFETY: getrusage writes into the struct it is given, nothing else.
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut ru) };
    let micros =
        |t: libc::timeval| t.tv_sec as i64 * 1_000_000 + t.tv_usec as i64;
    let cpu_us = micros(ru.ru_utime) + micros(ru.ru_stime);
    let line = format!(
        "{{\"wall_us\":{wall_us},\"maxrss_kb\":{},\"cpu_us\":{cpu_us},\
         \"code\":{code}}}\n",
        ru.ru_maxrss
    );
    // SAFETY: the caller opened this descriptor for this one report.
    let mut report = unsafe { std::fs::File::from_raw_fd(fd) };
    if report.write_all(line.as_bytes()).is_err() {
        eprint!("{line}");
    }
    std::process::exit(code);
}
