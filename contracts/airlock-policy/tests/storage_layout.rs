// AIR-040: the storage layout is frozen before the first testnet deploy (AIR-048), because the contract has no `migrate`.
// Two tests, neither starts a sandbox:
//  - `storage_key_bytes_follow_declaration_order`: the borsh bytes of the `StorageKey` variants are 0, 1, 2, ... in
//    declaration order, so a variant that is inserted instead of appended (which would move every later prefix) fails here.
//  - `state_fields_use_store_collections_with_unique_keys` (NEAR audit detector `storage-collision`): every collection of the
//    state is built from its own `StorageKey` variant, no collection takes a literal prefix, and no state field is a native
//    collection (a native collection is read and written whole on every call).
//
// A ticket that adds a `StorageKey` variant appends it to `variants()` below and bumps `VARIANT_COUNT` in its own commit.

use airlock_policy::StorageKey;
use near_sdk::borsh;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The number of `StorageKey` variants that exist (the template's four, `RevokedTasks` and `TaskActions` from AIR-045, `AllowedAgents` from AIR-046, `Assets` and `AssetSymbols` from AIR-042, `Book` from AIR-043, the four ledger keys from AIR-062, `Records` from AIR-063, `Nonces` and `EvmAttempts` from AIR-104).
const VARIANT_COUNT: usize = 17;

/// Every `StorageKey` variant, in declaration order, with its name as written in the enum.
fn variants() -> Vec<(&'static str, StorageKey)> {
    vec![
        ("ApprovedMeasurements", StorageKey::ApprovedMeasurements),
        ("ApprovedPpids", StorageKey::ApprovedPpids),
        ("Agents", StorageKey::Agents),
        (
            "WhitelistedAgentsForLocal",
            StorageKey::WhitelistedAgentsForLocal,
        ),
        ("Assets", StorageKey::Assets),
        ("AssetSymbols", StorageKey::AssetSymbols),
        ("Book", StorageKey::Book),
        ("RevokedTasks", StorageKey::RevokedTasks),
        ("TaskActions", StorageKey::TaskActions),
        ("AllowedAgents", StorageKey::AllowedAgents),
        ("AssetSpent", StorageKey::AssetSpent),
        ("PayeeSpent", StorageKey::PayeeSpent),
        ("PayeeUntrustedSpent", StorageKey::PayeeUntrustedSpent),
        ("TaskSpent", StorageKey::TaskSpent),
        ("Records", StorageKey::Records),
        ("Nonces", StorageKey::Nonces),
        ("EvmAttempts", StorageKey::EvmAttempts),
    ]
}

#[test]
fn storage_key_bytes_follow_declaration_order() {
    let list = variants();
    assert_eq!(
        list.len(),
        VARIANT_COUNT,
        "variants() and VARIANT_COUNT disagree: a ticket that adds a StorageKey variant appends it here and bumps the constant"
    );
    for (index, (name, key)) in list.iter().enumerate() {
        let bytes = borsh::to_vec(key).expect("a StorageKey serializes");
        assert_eq!(
            bytes,
            vec![u8::try_from(index).unwrap()],
            "StorageKey::{name} must borsh-serialize to the single byte {index}"
        );
    }
    // the list is the whole enum, in the order of the source
    let sources = read_sources();
    let all = join(&sources);
    let declared = enum_variants(&all);
    let listed: Vec<String> = list.iter().map(|(name, _)| (*name).to_string()).collect();
    assert_eq!(
        declared, listed,
        "the StorageKey enum in src/ and variants() differ (names or order)"
    );
}

#[test]
fn state_fields_use_store_collections_with_unique_keys() {
    // The scanner must be able to fail: each of these sources breaks exactly one rule.
    let enum_src = "pub enum StorageKey { A, B }";
    let good = format!(
        "{enum_src} pub struct Contract {{ pub a: LookupMap<u8, u8>, pub b: IterableSet<u8> }} \
         fn new() {{ LookupMap::new(StorageKey::A); IterableSet::new(StorageKey::B); }}"
    );
    assert_eq!(
        violations(&[source("good.rs", &good)]),
        Vec::<String>::new(),
        "the scanner rejects a clean state"
    );
    let bad: [(&str, String); 6] = [
        (
            "a variant feeds two constructors",
            format!(
                "{enum_src} fn f() {{ LookupMap::new(StorageKey::A); LookupSet::new(StorageKey::A); IterableSet::new(StorageKey::B); }}"
            ),
        ),
        (
            "a variant is never used",
            format!("{enum_src} fn f() {{ LookupMap::new(StorageKey::A); }}"),
        ),
        (
            "a literal byte prefix",
            format!(
                "{enum_src} fn f() {{ LookupMap::new(b\"x\"); LookupMap::new(StorageKey::A); IterableSet::new(StorageKey::B); }}"
            ),
        ),
        (
            "a literal vec prefix",
            format!(
                "{enum_src} fn f() {{ IterableMap::<u8, u8>::new(vec![1]); LookupMap::new(StorageKey::A); IterableSet::new(StorageKey::B); }}"
            ),
        ),
        (
            "a native Vec field",
            format!(
                "{enum_src} pub struct Contract {{ pub v: Vec<u8> }} fn f() {{ LookupMap::new(StorageKey::A); IterableSet::new(StorageKey::B); }}"
            ),
        ),
        (
            "a native HashMap field",
            format!(
                "{enum_src} pub struct Contract {{ pub m: HashMap<u8, u8> }} fn f() {{ LookupMap::new(StorageKey::A); IterableSet::new(StorageKey::B); }}"
            ),
        ),
    ];
    for (what, text) in &bad {
        assert!(
            !violations(&[source("bad.rs", text)]).is_empty(),
            "the scanner missed: {what}"
        );
    }

    // The real source.
    let found = violations(&read_sources());
    assert!(
        found.is_empty(),
        "storage layout violations:\n{}",
        found.join("\n")
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------------------------------------------------

const COLLECTIONS: &[&str] = &[
    "LookupMap",
    "LookupSet",
    "IterableMap",
    "IterableSet",
    "Vector",
    "TreeMap",
];
const NATIVE_COLLECTIONS: &[&str] = &["Vec<", "HashMap<", "HashSet<", "BTreeMap<", "BTreeSet<"];
const LITERAL_PREFIXES: &[&str] = &["b\"", "vec!", ".to_vec()", "&["];

struct Source {
    path: String,
    /// The text with line comments removed and the test-only parts cut.
    text: String,
}

fn source(path: &str, text: &str) -> Source {
    Source {
        path: path.to_string(),
        text: strip_comments(text),
    }
}

fn join(sources: &[Source]) -> String {
    sources
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_comments(text: &str) -> String {
    text.lines()
        .map(|line| line.find("//").map_or(line, |i| &line[..i]))
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(is_ident_char) && !s.starts_with(|c: char| c.is_ascii_digit())
}

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out.sort();
}

/// Reads every `.rs` file under `src/` except the test-only ones: `testutil.rs`, `internal/unit_tests.rs`, any file whose
/// `mod` line carries `#[cfg(test)]`, and (cut at the line) an inline `#[cfg(test)] mod <name> { ... }` to the end of its file.
fn read_sources() -> Vec<Source> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rs_files(&src, &mut files);
    assert!(!files.is_empty(), "no source files under {}", src.display());

    let mut test_only: HashSet<PathBuf> = HashSet::new();
    test_only.insert(src.join("testutil.rs"));
    test_only.insert(src.join("internal").join("unit_tests.rs"));
    let mut texts: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for file in &files {
        let lines: Vec<String> = fs::read_to_string(file)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        let stem = file.file_stem().unwrap().to_string_lossy().to_string();
        let parent = file.parent().unwrap();
        let child_dir = if ["lib", "main", "mod"].contains(&stem.as_str()) {
            parent.to_path_buf()
        } else {
            parent.join(&stem)
        };
        for (i, line) in lines.iter().enumerate() {
            if !line.trim().starts_with("#[cfg(test)]") {
                continue;
            }
            // the item the attribute belongs to: the next line that is not another attribute
            let item = lines[i + 1..]
                .iter()
                .map(|l| l.trim())
                .find(|l| !l.starts_with("#[") && !l.is_empty())
                .unwrap_or("");
            let item = item
                .trim_start_matches("pub(crate) ")
                .trim_start_matches("pub ");
            if let Some(rest) = item.strip_prefix("mod ") {
                if let Some(name) = rest.strip_suffix(';') {
                    test_only.insert(child_dir.join(format!("{}.rs", name.trim())));
                    test_only.insert(child_dir.join(name.trim()).join("mod.rs"));
                }
            }
        }
        texts.push((file.clone(), lines));
    }

    let mut out = Vec::new();
    for (file, lines) in texts {
        if test_only.contains(&file) {
            continue;
        }
        let mut keep = lines.len();
        for (i, line) in lines.iter().enumerate() {
            if line.trim().starts_with("#[cfg(test)]") {
                let item = lines[i + 1..]
                    .iter()
                    .map(|l| l.trim())
                    .find(|l| !l.starts_with("#[") && !l.is_empty())
                    .unwrap_or("");
                let item = item
                    .trim_start_matches("pub(crate) ")
                    .trim_start_matches("pub ");
                if item.starts_with("mod ") && item.trim_end().ends_with('{') {
                    keep = i;
                    break;
                }
            }
        }
        out.push(source(
            &file.display().to_string(),
            &lines[..keep].join("\n"),
        ));
    }
    out
}

/// The text between the `{` after `at` and its matching `}`.
fn braced_body(text: &str, at: usize) -> Option<&str> {
    let open = at + text[at..].find('{')?;
    let mut depth = 0usize;
    for (i, c) in text[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[open + 1..open + i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// The variant names of `enum StorageKey`, in declaration order.
fn enum_variants(text: &str) -> Vec<String> {
    let Some(at) = text.find("enum StorageKey") else {
        return Vec::new();
    };
    let Some(body) = braced_body(text, at) else {
        return Vec::new();
    };
    // drop `#[...]` attributes, then one variant per comma
    let mut clean = String::new();
    let mut depth = 0usize;
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '#' && chars.peek() == Some(&'[') {
            depth += 1;
            chars.next();
        } else if depth > 0 {
            match c {
                '[' => depth += 1,
                ']' => depth -= 1,
                _ => {}
            }
        } else {
            clean.push(c);
        }
    }
    clean
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Every `<collection>::new(<arg>)` or `<collection>::<..>::new(<arg>)` of the sources: (collection, argument text).
fn constructor_calls(text: &str) -> Vec<(String, String)> {
    let mut calls = Vec::new();
    for name in COLLECTIONS {
        let mut from = 0;
        while let Some(found) = text[from..].find(name) {
            let start = from + found;
            let end = start + name.len();
            from = end;
            if text[..start].chars().next_back().is_some_and(is_ident_char) {
                continue;
            }
            let mut rest = &text[end..];
            let Some(r) = rest.strip_prefix("::") else {
                continue;
            };
            rest = r;
            if rest.starts_with('<') {
                // skip the turbofish `<..>` (balanced), then `::`
                let mut depth = 0usize;
                let mut close = None;
                for (i, c) in rest.char_indices() {
                    match c {
                        '<' => depth += 1,
                        '>' => {
                            depth -= 1;
                            if depth == 0 {
                                close = Some(i);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                let Some(close) = close else { continue };
                let Some(r) = rest[close + 1..].strip_prefix("::") else {
                    continue;
                };
                rest = r;
            }
            let Some(r) = rest.strip_prefix("new(") else {
                continue;
            };
            // the argument runs to the matching `)`
            let mut depth = 1usize;
            let mut arg_end = None;
            for (i, c) in r.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            arg_end = Some(i);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(arg_end) = arg_end {
                calls.push(((*name).to_string(), r[..arg_end].to_string()));
            }
        }
    }
    calls
}

/// The (name, type) of every field of `struct Contract`.
fn contract_fields(text: &str) -> Vec<(String, String)> {
    let mut from = 0;
    while let Some(found) = text[from..].find("struct Contract") {
        let at = from + found;
        from = at + "struct Contract".len();
        if text[from..].chars().next().is_some_and(is_ident_char) {
            continue; // `struct ContractInfo`
        }
        let Some(body) = braced_body(text, at) else {
            continue;
        };
        return body
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("#["))
            .filter_map(|l| l.split_once(':'))
            .map(|(name, ty)| {
                let name = name
                    .trim()
                    .trim_start_matches("pub(crate) ")
                    .trim_start_matches("pub ")
                    .trim();
                (name.to_string(), ty.trim().to_string())
            })
            .collect();
    }
    Vec::new()
}

fn violations(sources: &[Source]) -> Vec<String> {
    let all = join(sources);
    let mut out = Vec::new();
    let declared = enum_variants(&all);
    if declared.is_empty() {
        out.push("no `enum StorageKey` found in the sources".to_string());
    }
    let mut uses: BTreeMap<String, usize> = BTreeMap::new();
    for source in sources {
        for (collection, arg) in constructor_calls(&source.text) {
            let compact: String = arg
                .split_whitespace()
                .collect::<String>()
                .trim_end_matches(',')
                .to_string();
            let path = &source.path;
            if LITERAL_PREFIXES.iter().any(|p| compact.contains(p)) {
                out.push(format!(
                    "{path}: {collection}::new takes a literal prefix: `{compact}`"
                ));
                continue;
            }
            match compact.strip_prefix("StorageKey::") {
                Some(variant) if is_ident(variant) => {
                    *uses.entry(variant.to_string()).or_default() += 1
                }
                _ => out.push(format!(
                    "{path}: {collection}::new must take a `StorageKey::<Variant>`, got `{compact}`"
                )),
            }
        }
    }
    for variant in &declared {
        match uses.get(variant) {
            Some(1) => {}
            Some(n) => out.push(format!(
                "StorageKey::{variant} feeds {n} collections, it must feed exactly one"
            )),
            None => out.push(format!("StorageKey::{variant} feeds no collection")),
        }
    }
    for variant in uses.keys() {
        if !declared.contains(variant) {
            out.push(format!("StorageKey::{variant} is used but not declared"));
        }
    }
    for (name, ty) in contract_fields(&all) {
        if NATIVE_COLLECTIONS.iter().any(|p| ty.starts_with(p)) {
            out.push(format!("Contract field `{name}: {ty}` is a native collection, use a near_sdk::store collection"));
        }
    }
    out
}
