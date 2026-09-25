//! Cached normalized conversation transcript.
//!
//! Reopening a conversation used to re-derive every finished process from
//! scratch: read the whole raw JSONL into a `String`, parse it into
//! `Vec<LogMsg>`, push every message through a temporary `MsgStore` (which
//! clones each one into its 100k-slot broadcast ring), recreate the git
//! worktree, and re-run the executor's normalizer — for every process, on
//! every open. Measured on this machine, ~90% of a raw opencode log is
//! `message.part.delta` streaming noise, so that work produced roughly 20x the
//! bytes of the answer it was rebuilding.
//!
//! The normalized patches are a few percent of the raw log, so they are kept
//! beside it and reused. The sidecar is keyed by the raw file's (size, mtime):
//! any append invalidates it, and a process with no raw file (cloud-imported /
//! DB-only history) simply skips the cache and keeps the existing replay path.

use std::path::PathBuf;

use json_patch::Patch;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use utils::execution_logs::{process_log_cache_path, process_log_file_path};

const CACHE_VERSION: u32 = 1;

/// Identity of the raw JSONL a cached transcript was derived from. Opaque to
/// callers — they only carry it between [`raw_fingerprint`], [`load`] and
/// [`store`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawFingerprint {
    size: u64,
    mtime_ns: i64,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    raw: RawFingerprint,
    patches: Vec<Patch>,
}

/// Fingerprint of the raw JSONL behind `process_id`. `None` means "no file to
/// key on" — the caller then bypasses the cache entirely.
pub async fn raw_fingerprint(
    session_id: uuid::Uuid,
    process_id: uuid::Uuid,
) -> Option<RawFingerprint> {
    let meta = tokio::fs::metadata(process_log_file_path(session_id, process_id))
        .await
        .ok()?;
    let mtime_ns = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos() as i64;
    Some(RawFingerprint {
        size: meta.len(),
        mtime_ns,
    })
}

fn cache_path(session_id: uuid::Uuid, process_id: uuid::Uuid) -> PathBuf {
    process_log_cache_path(session_id, process_id)
}

/// Cached normalized patches, or `None` on miss / stale / corrupt sidecar.
pub async fn load(
    session_id: uuid::Uuid,
    process_id: uuid::Uuid,
    fingerprint: RawFingerprint,
) -> Option<Vec<Patch>> {
    let bytes = tokio::fs::read(cache_path(session_id, process_id))
        .await
        .ok()?;
    let file: CacheFile = serde_json::from_slice(&bytes).ok()?;
    if file.version != CACHE_VERSION || file.raw != fingerprint {
        return None;
    }
    Some(file.patches)
}

/// Persist the normalized transcript. Best-effort: a failed write only costs
/// the next open the (now recovered) normalization pass.
pub async fn store(
    session_id: uuid::Uuid,
    process_id: uuid::Uuid,
    fingerprint: RawFingerprint,
    patches: &[Patch],
) {
    let file = CacheFile {
        version: CACHE_VERSION,
        raw: fingerprint,
        patches: patches.to_vec(),
    };
    let Ok(bytes) = serde_json::to_vec(&file) else {
        return;
    };

    let path = cache_path(session_id, process_id);
    let Some(parent) = path.parent() else { return };
    if let Err(err) = tokio::fs::create_dir_all(parent).await {
        tracing::debug!("normalized cache: cannot create {parent:?}: {err}");
        return;
    }

    // Write-then-rename so a crash mid-write can never leave a truncated file
    // that would later parse as a valid (but partial) transcript.
    let tmp = path.with_extension("normalized.json.tmp");
    let mut wrote = false;
    if let Ok(mut file_handle) = tokio::fs::File::create(&tmp).await {
        wrote = file_handle.write_all(&bytes).await.is_ok() && file_handle.flush().await.is_ok();
    }
    if !wrote {
        let _ = tokio::fs::remove_file(&tmp).await;
        return;
    }
    if let Err(err) = tokio::fs::rename(&tmp, &path).await {
        tracing::debug!("normalized cache: rename failed for {path:?}: {err}");
        let _ = tokio::fs::remove_file(&tmp).await;
    }
}
