use std::{fs, path::Path};

fn main() {
    // Load .env from the workspace root so builds see local overrides.
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let env_file = workspace_root.join(".env");
    dotenv::from_path(&env_file).ok();
    if env_file.exists() {
        println!("cargo:rerun-if-changed={}", env_file.display());
    }

    // Build identity for the About/build tracker: an always-increasing
    // commit count plus the short SHA, baked at compile time. Best-effort:
    // missing git metadata must never fail the build (CI tarballs, etc.).
    let git_dir = workspace_root.join(".git");
    if git_dir.exists() {
        println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
    }
    let build_number = std::process::Command::new("git")
        .args(["rev-list", "--count", "HEAD"])
        .current_dir(&workspace_root)
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "0".to_string());
    let build_sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&workspace_root)
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=AURAPUNK_BUILD_NUMBER={build_number}");
    println!("cargo:rustc-env=AURAPUNK_BUILD_SHA={build_sha}");
    let dist_path = Path::new("../../packages/local-web/dist");
    if !dist_path.exists() {
        println!("cargo:warning=Creating dummy packages/local-web/dist directory for compilation");
        fs::create_dir_all(dist_path).unwrap();

        // Create a dummy index.html
        let dummy_html = r#"<!DOCTYPE html>
<html><head><title>Build web app first</title></head>
<body><h1>Please build @vibe/local-web first</h1></body></html>"#;

        fs::write(dist_path.join("index.html"), dummy_html).unwrap();
    }
}
