use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;
use workspace_utils::command_ext::GroupSpawnNoWindowExt;

use crate::{
    actions::Executable,
    approvals::ExecutorApprovalService,
    env::ExecutionEnv,
    executors::{ExecutorError, SpawnedChild},
};

/// Runs the locally installed OpenCodeReview CLI against a workspace repository.
///
/// OpenCodeReview remains an optional integration: AuraPunk never installs or
/// configures it, and users retain control of its provider and credentials.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct OpenCodeReviewRequest {
    /// When present, review the range from this commit through the current HEAD.
    #[serde(default)]
    pub base_commit: Option<String>,
    /// Optional relative path to execute in, relative to the workspace root.
    #[serde(default)]
    pub working_dir: Option<String>,
}

impl OpenCodeReviewRequest {
    pub fn effective_dir(&self, current_dir: &Path) -> std::path::PathBuf {
        self.working_dir
            .as_ref()
            .map(|relative_path| current_dir.join(relative_path))
            .unwrap_or_else(|| current_dir.to_path_buf())
    }
}

#[async_trait]
impl Executable for OpenCodeReviewRequest {
    async fn spawn(
        &self,
        current_dir: &Path,
        _approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut command = Command::new("ocr");
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .args(["review", "--format", "json"])
            .current_dir(self.effective_dir(current_dir));

        if let Some(base_commit) = &self.base_commit {
            command.args(["--from", base_commit, "--to", "HEAD"]);
        }

        env.apply_to_command(&mut command);

        let child = command.group_spawn_no_window().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ExecutorError::ExecutableNotFound {
                    program: "ocr".to_string(),
                }
            } else {
                ExecutorError::Io(error)
            }
        })?;

        Ok(child.into())
    }
}
