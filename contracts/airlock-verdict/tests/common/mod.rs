//! Shared helper of the integration tests that talk to an example binary of this crate (AIR-023; AIR-033 and AIR-034 reuse it).
//!
//! `cargo test --test cli` builds only the selected test target and no example, and `CARGO_BIN_EXE_<name>` exists only for `[[bin]]`
//! targets (which would make `serde_json` a normal dependency of this dependency free crate). So the helper builds the example itself,
//! once per example and test process, and a stale example can never be the one under test.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

static BUILT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// The path of the example `name` after `cargo build --example <name>` has succeeded in this process (release when the tests are).
pub fn example_bin(name: &str) -> PathBuf {
    {
        let mut built = BUILT
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .expect("build lock");
        if !built.contains(name) {
            let mut build = Command::new(env!("CARGO"));
            build.args(["build", "--quiet", "--example", name]);
            if !cfg!(debug_assertions) {
                build.arg("--release");
            }
            let status = build.status().expect("cargo build could not start");
            assert!(status.success(), "cargo build --example {name} failed");
            built.insert(name.to_string());
        }
    }
    let exe = std::env::current_exe().expect("current_exe");
    // target/<profile>/deps/<test binary> to target/<profile>/examples/<name>
    let profile_dir = exe
        .parent()
        .and_then(|deps| deps.parent())
        .expect("target profile directory");
    profile_dir.join("examples").join(name)
}
