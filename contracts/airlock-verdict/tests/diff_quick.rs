//! Differential test for cargo-mutants (AIR-033): the Rust verdict against the Lean runner's output on one fixed case file.
//!
//! cargo-mutants runs only `cargo test` per mutant, so the comparison of scripts/diff-verdict.sh must be an ordinary Rust test.
//! `DIFF_CASES` is the case file (21 integers per line, the AIR-023 format) and `DIFF_EXPECT` the Lean tags for the same cases,
//! computed once by scripts/mutation.sh because they do not depend on the mutation. Without `DIFF_CASES` the test is skipped and
//! passes; with it, any unreadable file, a wrong line count or a differing line is a failure, never a skip.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};

fn read(var: &str, path: &str) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("diff_quick: cannot read {var}={path}: {e}"))
}

#[test]
fn rust_verdict_equals_lean_on_the_case_file() {
    let Some(cases_path) = std::env::var_os("DIFF_CASES") else {
        println!("diff_quick: skipped (DIFF_CASES not set)");
        return;
    };
    let cases_path = cases_path.to_string_lossy().into_owned();
    let expect_path = std::env::var("DIFF_EXPECT")
        .unwrap_or_else(|_| panic!("diff_quick: DIFF_CASES is set but DIFF_EXPECT is not"));
    let cases = read("DIFF_CASES", &cases_path);
    let expect = read("DIFF_EXPECT", &expect_path);

    let bin = common::example_bin("diff");
    let mut child = Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| panic!("diff_quick: cannot start {}: {e}", bin.display()));
    let mut stdin = child.stdin.take().expect("stdin");
    let feed = cases.clone();
    let writer = std::thread::spawn(move || {
        // a mutant that makes the driver exit early closes the pipe: that is a difference, not a crash of the test
        let _ = stdin.write_all(feed.as_bytes());
    });
    let out = child.wait_with_output().expect("diff driver output");
    writer.join().expect("writer thread");
    assert!(
        out.status.success(),
        "diff_quick: the diff driver exited with {}",
        out.status
    );
    let got = String::from_utf8(out.stdout).expect("driver output is utf-8");

    let want: Vec<&str> = expect.lines().collect();
    let have: Vec<&str> = got.lines().collect();
    let n_cases = cases.lines().count();
    if want.len() != n_cases || have.len() != n_cases {
        let first = want
            .iter()
            .zip(have.iter())
            .position(|(a, b)| a != b)
            .map_or(want.len().min(have.len()) + 1, |i| i + 1);
        panic!(
            "diff_quick: first difference at case {first} (line counts: {n_cases} cases, {} expected, {} from Rust)",
            want.len(),
            have.len()
        );
    }
    if let Some(i) = want.iter().zip(have.iter()).position(|(a, b)| a != b) {
        let k = i + 1;
        panic!(
            "diff_quick: first difference at case {k}: expected {} but Rust printed {}",
            want[i], have[i]
        );
    }
    println!("diff_quick: compared {n_cases} cases");
}
