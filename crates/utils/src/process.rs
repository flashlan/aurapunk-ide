use command_group::AsyncGroupChild;
#[cfg(unix)]
use tokio::time::Duration;

/// Kill any `opencode serve --hostname 127.0.0.1` processes still running from
/// a previous instance of this app.
///
/// The OpenCode executor spawns a fresh detached HTTP server for every single
/// turn (not once per workspace — see `executors::opencode`), and normally
/// kills it when that turn's execution finishes. If the app itself is
/// force-quit, crashes, or is hard-restarted mid-turn, none of those kill
/// paths run, and the server is orphaned permanently — there is no PID
/// persisted anywhere to reap it by ID later. Since this only runs once, at
/// startup, before this instance has spawned anything of its own, any
/// process matching this exact signature that's already running cannot
/// belong to this instance — it's safe to kill unconditionally. Only this
/// one exact command-line pattern is targeted; nothing else is touched.
///
/// The match deliberately omits the `--port` value: the executor pins a
/// per-turn free port, so the argv ends in `--port <n>` (older builds passed
/// `--port 0`). Matching the prefix reaps both. The headed TUI does not use
/// the `serve` subcommand, so it is never touched.
#[cfg(unix)]
pub async fn kill_stale_opencode_servers() {
    const SIGNATURE: &str = "opencode serve --hostname 127.0.0.1";

    let output = match tokio::process::Command::new("pgrep")
        .args(["-f", SIGNATURE])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            tracing::debug!("pgrep unavailable, skipping stale opencode server sweep: {e}");
            return;
        }
    };

    let pids: Vec<i32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .collect();

    if pids.is_empty() {
        return;
    }

    tracing::info!(
        "Found {} stale opencode server process(es) from a previous run; killing them",
        pids.len()
    );
    for pid in pids {
        use nix::{sys::signal::Signal, unistd::Pid};
        // TERM first so the process can shut down its own children/sockets
        // cleanly; KILL is the backstop for anything that ignores it.
        let _ = nix::sys::signal::kill(Pid::from_raw(pid), Signal::SIGTERM);
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    if let Ok(output) = tokio::process::Command::new("pgrep")
        .args(["-f", SIGNATURE])
        .output()
        .await
    {
        for pid in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<i32>().ok())
        {
            use nix::{sys::signal::Signal, unistd::Pid};
            let _ = nix::sys::signal::kill(Pid::from_raw(pid), Signal::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
pub async fn kill_stale_opencode_servers() {
    // No-op on non-Unix targets for now; the leak is Unix-signal-cleanup
    // specific (see the `#[cfg(unix)]` version's doc comment).
}

pub async fn kill_process_group(child: &mut AsyncGroupChild) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // Use command_group's UnixChildExt::signal() which calls killpg()
        // with the pgid captured at spawn time. This works even after the
        // group leader has exited, unlike getpgid() which would fail.
        use command_group::{Signal, UnixChildExt};

        for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
            tracing::info!("Sending {:?} to process group", sig);
            if let Err(e) = child.signal(sig) {
                // Break if the group does not exist anymore (ESRCH) or already exited/reaped (EPERM on macOS)
                if e.raw_os_error() == Some(nix::libc::ESRCH)
                    || e.raw_os_error() == Some(nix::libc::EPERM)
                {
                    break;
                }
                tracing::warn!("Failed to send signal {:?} to process group: {}", sig, e);
            }
            if sig != Signal::SIGKILL {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(())
}
