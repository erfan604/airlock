// AIR-041: the exported method set of the built wasm is the list in tests/abi_expected.txt and nothing else. The template could
// sign any digest for any registered agent (`request_signature`, red team RT-01); this test fails if that method, or any other
// unlisted public method, ever appears again (AB3: no standing grants, no "approve all").
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first (the tests read `contract_wasm_path()`).
//
// Three tests: `every_export_is_listed` and `no_backdoor_exports` run now, `abi_complete_equals_spec` is switched on by AIR-066
// (when every method of the spec exists).

mod common;

use common::wasm_exports;
use std::collections::BTreeSet;

/// Exports that are not contract methods. Exactly four rules: adding a fifth needs a line in the notes of AIR-041 saying what
/// exports it.
fn is_ignored(name: &str) -> bool {
    name == "memory"
        || name.starts_with('_')
        || name == "contract_source_metadata" // written by cargo-near
        || name.starts_with("ring_core_") // exported by the ring crate the attestation code pulls in
}

/// Names that must never be exported (AB3). A substring match, like an unanchored alternation.
const BACKDOORS: &[&str] = &[
    "request_signature",
    "update_contract",
    "migrate",
    "cancel",
    "approve_all",
    "approve_batch",
    "batch_approve",
    "approve_many",
    "standing",
    "schedule_payment",
    "grant",
];

fn expected() -> BTreeSet<String> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/abi_expected.txt");
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {path}: {e}"))
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// The exports that are contract methods.
fn exported_methods() -> BTreeSet<String> {
    wasm_exports()
        .into_iter()
        .filter(|n| !is_ignored(n))
        .collect()
}

#[test]
fn every_export_is_listed() {
    // the filter itself: these four are ignored, a real method is kept
    for sample in [
        "memory",
        "_x",
        "contract_source_metadata",
        "ring_core_0_17_14__bn_mul_mont",
    ] {
        assert!(is_ignored(sample), "{sample} must be ignored");
    }
    assert!(!is_ignored("get_policy"), "get_policy must be kept");

    let listed = expected();
    assert!(
        listed.contains("get_policy"),
        "tests/abi_expected.txt did not load"
    );
    let raw = wasm_exports();
    assert!(
        raw.iter().any(|n| n == "get_policy"),
        "the wasm exports no get_policy: is it the policy wasm? exports: {raw:?}"
    );
    let unlisted: Vec<String> = exported_methods()
        .into_iter()
        .filter(|n| !listed.contains(n))
        .collect();
    assert!(
        unlisted.is_empty(),
        "exported but not in tests/abi_expected.txt: {unlisted:?}"
    );
}

#[test]
fn no_backdoor_exports() {
    let raw = wasm_exports();
    assert!(!raw.is_empty(), "the wasm exports nothing");
    let found: Vec<String> = raw
        .into_iter()
        .filter(|n| BACKDOORS.iter().any(|b| n.contains(b)))
        .collect();
    assert!(
        found.is_empty(),
        "the wasm exports a method that must not exist: {found:?}"
    );
}

#[test]
#[ignore = "enabled by AIR-066"]
fn abi_complete_equals_spec() {
    let listed = expected();
    let exported = exported_methods();
    let missing: Vec<&String> = listed.difference(&exported).collect();
    let extra: Vec<&String> = exported.difference(&listed).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "listed but not exported: {missing:?}; exported but not listed: {extra:?}"
    );
}
