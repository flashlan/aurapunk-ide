//! Identity and capacity information for a Desktop or cloud execution node.
//!
//! The Tailcat address is only a transport hint. `instance_id` is the stable
//! identity used by the Cloud lease registry, and `direct_token` is required
//! by the direct Mobile endpoints. Workspaces do not get their own addresses.

use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{Router, extract::State, response::Json as ResponseJson, routing::get};
use deployment::Deployment;
use serde::Serialize;
use utils::{assets::asset_dir, response::ApiResponse};
use uuid::Uuid;

use crate::DeploymentImpl;

#[derive(Debug, Clone, Serialize)]
pub struct InstanceCapacity {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub disk_bytes: u64,
    pub worktree_root: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstanceUsage {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub disk_bytes: u64,
    pub active_worktrees: u64,
    pub active_containers: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstanceDescriptor {
    pub instance_id: String,
    pub name: String,
    pub kind: String,
    pub transport: String,
    pub tailcat_endpoint: Option<String>,
    pub tailcat_connection_blob: Option<String>,
    pub direct_token: String,
    pub capacity: InstanceCapacity,
    pub usage: InstanceUsage,
    pub container_ttl_seconds: u64,
    pub updated_at: u64,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/instance", get(get_instance))
}

pub async fn get_instance(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<InstanceDescriptor>> {
    ResponseJson(ApiResponse::success(describe(&deployment)))
}

/// Build the node descriptor that is also embedded in `/api/mobile/context`.
/// The descriptor is deliberately deterministic between process restarts so a
/// Cloud lease can continue to refer to the same execution node.
pub fn describe(_deployment: &impl Deployment) -> InstanceDescriptor {
    let data_dir = asset_dir();
    let instance_id = persisted_value(&data_dir.join("instance-id"), || {
        format!("instance_{}", Uuid::new_v4().simple())
    });
    let direct_token = persisted_value(&data_dir.join("tailcat-direct-token"), || {
        format!("tc_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
    });
    let endpoint = std::env::var("AURAPUNK_TAILCAT_ENDPOINT")
        .or_else(|_| std::env::var("TAILCAT_ENDPOINT"))
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());
    let connection_blob = std::env::var("AURAPUNK_TAILCAT_CONN_BLOB")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let worktree_root = data_dir.join("worktrees");

    InstanceDescriptor {
        instance_id,
        name: std::env::var("AURAPUNK_INSTANCE_NAME")
            .unwrap_or_else(|_| "AuraPunk Desktop".to_string()),
        kind: "desktop".to_string(),
        transport: "tailcat".to_string(),
        tailcat_endpoint: endpoint,
        tailcat_connection_blob: connection_blob,
        direct_token,
        capacity: InstanceCapacity {
            cpu_millis: std::thread::available_parallelism()
                .map(|count| count.get() as u64 * 1_000)
                .unwrap_or(1_000),
            memory_bytes: host_memory_bytes(),
            disk_bytes: available_disk_bytes(&worktree_root),
            worktree_root: worktree_root.display().to_string(),
        },
        usage: InstanceUsage {
            cpu_millis: 0,
            memory_bytes: 0,
            disk_bytes: 0,
            active_worktrees: 0,
            active_containers: 0,
        },
        container_ttl_seconds: std::env::var("AURAPUNK_CONTAINER_TTL_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(3_600),
        updated_at: now_millis(),
    }
}

fn persisted_value(path: &Path, generate: impl FnOnce() -> String) -> String {
    if let Ok(value) = fs::read_to_string(path) {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return value;
        }
    }
    let value = generate();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, &value);
    value
}

fn host_memory_bytes() -> u64 {
    if let Ok(contents) = fs::read_to_string("/proc/meminfo")
        && let Some(value) = contents.lines().find_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next() == Some("MemTotal:")).then(|| fields.next()?.parse::<u64>().ok())?
        })
    {
        return value * 1_024;
    }

    if let Ok(output) = Command::new("sysctl").args(["-n", "hw.memsize"]).output()
        && output.status.success()
        && let Ok(value) = String::from_utf8_lossy(&output.stdout).trim().parse()
    {
        return value;
    }

    0
}

fn available_disk_bytes(path: &Path) -> u64 {
    if fs::create_dir_all(path).is_err() {
        return 0;
    }
    let Some(output) = Command::new("df").arg("-kP").arg(path).output().ok() else {
        return 0;
    };
    if !output.status.success() {
        return 0;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .nth(1)
        .and_then(|line| line.split_whitespace().nth(3))
        .and_then(|value| value.parse::<u64>().ok())
        .map(|blocks| blocks.saturating_mul(1_024))
        .unwrap_or(0)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_has_stable_identity_and_nonzero_cpu_capacity() {
        let first = persisted_value(Path::new("/tmp/aurapunk-instance-test"), || "one".into());
        let second = persisted_value(Path::new("/tmp/aurapunk-instance-test"), || "two".into());
        assert_eq!(first, second);
        assert!(std::thread::available_parallelism().is_ok());
    }
}
