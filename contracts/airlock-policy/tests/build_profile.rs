// AIR-040, NEAR audit detector `unsafe-math`: the release wasm must panic on integer overflow, so a wrapped counter can never
// reset a limit. Unit tests run in debug, where overflow always panics; only `overflow-checks = true` in the release profile
// makes the deployed wasm panic too. Inside a cargo workspace a member's own `[profile.release]` is ignored, so the test reads
// the `Cargo.toml` at cargo's `workspace_root`, which is the manifest cargo actually takes the profile from.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn workspace_root() -> PathBuf {
    let out = Command::new(env!("CARGO"))
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo metadata runs");
    assert!(
        out.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("cargo metadata prints JSON");
    PathBuf::from(
        metadata["workspace_root"]
            .as_str()
            .expect("cargo metadata has a workspace_root"),
    )
}

/// The lines of the `[profile.release]` table (up to the next `[` header), comments removed and blanks dropped.
fn release_profile_lines(manifest: &str) -> Vec<String> {
    let mut in_table = false;
    let mut lines = Vec::new();
    for raw in manifest.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            in_table = line == "[profile.release]";
            continue;
        }
        if in_table && !line.is_empty() {
            lines.push(line.to_string());
        }
    }
    lines
}

#[test]
fn release_profile_has_overflow_checks() {
    let manifest_path = workspace_root().join("Cargo.toml");
    let manifest = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", manifest_path.display()));
    let table = release_profile_lines(&manifest);
    assert!(
        !table.is_empty(),
        "{} has no [profile.release] table",
        manifest_path.display()
    );
    let has_overflow_checks = table.iter().any(|line| {
        line.split_once('=')
            .is_some_and(|(key, value)| key.trim() == "overflow-checks" && value.trim() == "true")
    });
    assert!(
        has_overflow_checks,
        "the [profile.release] table of {} must contain `overflow-checks = true`, found: {table:?}",
        manifest_path.display()
    );
}
