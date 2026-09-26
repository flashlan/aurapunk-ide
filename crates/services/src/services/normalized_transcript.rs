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

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use futures::StreamExt;
use json_patch::Patch;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, task::JoinHandle};
use utils::{
    execution_logs::{process_log_cache_path, process_log_file_path},
    msg_store::MsgStore,
};
use uuid::Uuid;

use crate::services::container::{PatchOrDone, dedup_until_ready};

const CACHE_VERSION: u32 = 1;

/// Full normalizations run one at a time. A cold re-normalization of a large
/// opencode log briefly holds several copies of it (raw `String`, parsed
/// `Vec<LogMsg>`, the temporary `MsgStore`, the produced patches) — measured at
/// ~900 MB peak for a 77 MB JSONL. Opening a workspace asks for many historic
/// processes at once, and doing them in parallel multiplied that peak until an
/// 8 GB machine swapped hard. Serializing keeps the peak at one transcript;
/// waiters re-check the sidecar after acquiring, so a transcript requested
/// twice is only normalized once.
pub static NORMALIZE_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

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

/// Normalizer tasks of live processes whose `MsgStore` has seen the process
/// from its first line. Only those stores can produce a complete transcript at
/// exit; a process resumed after an app restart starts with an empty store and
/// is deliberately never registered.
static LIVE_NORMALIZERS: LazyLock<Mutex<HashMap<Uuid, Vec<JoinHandle<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long exit waits for normalizers to drain the tail after `Finished`.
const NORMALIZER_DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Remember the normalizer tasks of a process started from scratch, so its
/// transcript can be persisted when it exits (see [`persist_finished`]).
pub fn register_live_normalizers(process_id: Uuid, handles: Vec<JoinHandle<()>>) {
    LIVE_NORMALIZERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(process_id, handles);
}

/// Persist the normalized transcript of a process that just exited, straight
/// from its live `MsgStore`, so the first open never pays the cold
/// re-normalization (which peaks near 1 GB for large opencode logs).
///
/// Call after `Finished` was pushed and the raw JSONL was flushed. Writes
/// nothing — leaving the cold path as the fallback — unless the process was
/// registered at start, every normalizer finished draining, and the store
/// never evicted history.
pub async fn persist_finished(session_id: Uuid, process_id: Uuid, msg_store: &MsgStore) {
    let handles = LIVE_NORMALIZERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&process_id);
    let Some(handles) = handles else { return };

    for handle in handles {
        match tokio::time::timeout(NORMALIZER_DRAIN_TIMEOUT, handle).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::debug!("normalized cache: normalizer for {process_id} failed: {err}");
                return;
            }
            Err(_) => {
                tracing::debug!("normalized cache: normalizer for {process_id} did not drain");
                return;
            }
        }
    }
    if !msg_store.history_is_complete() {
        tracing::debug!("normalized cache: {process_id} history was evicted; not persisting");
        return;
    }
    let Some(fingerprint) = raw_fingerprint(session_id, process_id).await else {
        return;
    };
    if load(session_id, process_id, fingerprint).await.is_some() {
        return;
    }

    let source = futures::stream::iter(
        msg_store
            .history_patches()
            .into_iter()
            .map(PatchOrDone::Patch)
            .chain(std::iter::once(PatchOrDone::Done)),
    )
    .boxed();
    let patches: Vec<Patch> = dedup_until_ready(source).collect().await;
    store(session_id, process_id, fingerprint, &patches).await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use utils::log_msg::LogMsg;

    use super::*;

    fn add(path: &str, text: &str) -> Patch {
        serde_json::from_value(serde_json::json!([
            { "op": "add", "path": path, "value": { "content": text } }
        ]))
        .unwrap()
    }

    /// Raw JSONL on disk so the transcript has a fingerprint to key on.
    async fn write_raw(session_id: Uuid, process_id: Uuid) {
        let path = process_log_file_path(session_id, process_id);
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, b"{\"Stdout\":\"hello\\n\"}\n")
            .await
            .unwrap();
    }

    async fn cleanup(session_id: Uuid) {
        let dir = utils::execution_logs::process_logs_session_dir(session_id);
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    fn finished_store() -> Arc<MsgStore> {
        let store = Arc::new(MsgStore::new());
        store.push(LogMsg::Stdout("hello\n".into()));
        store.push_patch(add("/entries/0", "draft"));
        store.push_patch(add("/entries/0", "final"));
        store.push_patch(add("/entries/1", "next"));
        store.push_finished();
        store
    }

    #[tokio::test]
    async fn persists_a_registered_process_at_exit() {
        let (session_id, process_id) = (Uuid::new_v4(), Uuid::new_v4());
        write_raw(session_id, process_id).await;
        let store = finished_store();
        register_live_normalizers(process_id, vec![tokio::spawn(async {})]);

        persist_finished(session_id, process_id, &store).await;

        let fingerprint = raw_fingerprint(session_id, process_id).await.unwrap();
        let cached = load(session_id, process_id, fingerprint).await;
        cleanup(session_id).await;
        // Same dedup as the cold path: the two writes to entry 0 collapse.
        assert_eq!(cached.map(|patches| patches.len()), Some(2));
    }

    #[tokio::test]
    async fn skips_a_process_that_was_not_registered() {
        // e.g. resumed after an app restart: its store lacks the early lines.
        let (session_id, process_id) = (Uuid::new_v4(), Uuid::new_v4());
        write_raw(session_id, process_id).await;

        persist_finished(session_id, process_id, &finished_store()).await;

        let fingerprint = raw_fingerprint(session_id, process_id).await.unwrap();
        let cached = load(session_id, process_id, fingerprint).await;
        cleanup(session_id).await;
        assert!(cached.is_none());
    }
}
