//! AIR-086 (decision R4-12): the minified JSON arguments of `approve` must stay under the 200 bytes a Ledger device can show. This test
//! builds the real JSON for every key form, checks `approve_args_len` against it, prints the measurement table of
//! docs/design/approve-args.md (`ROW <n> <description> <bytes>`), and checks the registry guard's formula (`amount_text_len`) against
//! the longest text `decimal::format` can produce. No character is escaped with a backslash and `u`.

use airlock_verdict::approve::{
    amount_text_len, approve_args_len, LEDGER_LIMIT, MAX_BOOK, MAX_ID_DIGITS, MAX_SYMBOL, MAX_TO,
    MAX_WHY,
};
use airlock_verdict::decimal;
use serde_json::json;

const DEMO_EVM_KEY: &str = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const ETH_BASE: &str = "ETH.base";
/// One base unit of an 18 decimal asset.
const ONE_BASE_UNIT: &str = "0.000000000000000001";
const WHY: &str = "UntrustedRecipient";

fn near_key_64() -> String {
    format!("near:{}", "a".repeat(64))
}

fn request_id(index: &str) -> String {
    format!("{}:{index}", "ab".repeat(32))
}

/// The real minified arguments with the old names (SPEC 8.2).
fn long_json(
    id: &str,
    key: &str,
    symbol: &str,
    amount: &str,
    why: &str,
    book: &str,
) -> serde_json::Value {
    json!({
        "request_id": id,
        "recipient": key,
        "asset_symbol": symbol,
        "amount_decimal": amount,
        "reason": why,
        "book_status": book,
    })
}

/// The real minified arguments with the short names of the decision.
fn short_json(
    id: &str,
    key: &str,
    symbol: &str,
    amount: &str,
    why: &str,
    book: &str,
) -> serde_json::Value {
    json!({ "id": id, "to": key, "asset": symbol, "amount": amount, "why": why, "book": book })
}

fn formula(id: &str, key: &str, symbol: &str, amount: &str, why: &str, book: &str) -> usize {
    approve_args_len(
        id.len(),
        key.len(),
        symbol.len(),
        amount.len(),
        why.len(),
        book.len(),
    )
}

fn row(n: u32, description: &str, bytes: usize) {
    println!("\nROW {n} {description} {bytes}");
}

#[test]
fn measurement_table() {
    let key52 = DEMO_EVM_KEY;
    let key69 = near_key_64();
    let id66 = request_id("0");
    let id67 = request_id("10");
    assert_eq!(
        (key52.len(), key69.len(), id66.len(), id67.len()),
        (52, 69, 66, 67)
    );
    assert_eq!(ONE_BASE_UNIT.len(), 20);

    // rows 1 and 2: the long names of SPEC 8.2 and the request id as the id
    let r1 = long_json(&id66, key52, ETH_BASE, ONE_BASE_UNIT, WHY, "new")
        .to_string()
        .len();
    let r2 = long_json(&id66, &key69, ETH_BASE, ONE_BASE_UNIT, WHY, "new")
        .to_string()
        .len();
    // rows 3 and 4: the short names, still with the request id
    let r3 = short_json(&id66, key52, ETH_BASE, ONE_BASE_UNIT, WHY, "new")
        .to_string()
        .len();
    let r4 = short_json(&id66, &key69, ETH_BASE, ONE_BASE_UNIT, WHY, "new")
        .to_string()
        .len();
    // row 5: the short names and the short pending number
    let r5 = short_json("1234", key52, ETH_BASE, ONE_BASE_UNIT, WHY, "new")
        .to_string()
        .len();
    // row 6: the short names and every maximum
    let max_amount = decimal::format(u128::MAX, 38).expect("38 decimals format");
    let max_amount = String::from_utf8(max_amount.0[..max_amount.1].to_vec()).unwrap();
    assert_eq!(max_amount, "3.40282366920938463463374607431768211455");
    assert_eq!(max_amount.len(), 40);
    let r6 = short_json(
        "4294967295",
        &key69,
        "ABCDEFGHIJKL",
        &max_amount,
        WHY,
        "in_book",
    )
    .to_string()
    .len();

    row(
        1,
        "long names, 66 character request id, evm key (52), ETH.base, one base unit, new",
        r1,
    );
    row(
        2,
        "long names, 66 character request id, near key (69), ETH.base, one base unit, new",
        r2,
    );
    row(
        3,
        "short names, 66 character request id, evm key (52), ETH.base, one base unit, new",
        r3,
    );
    row(
        4,
        "short names, 66 character request id, near key (69), ETH.base, one base unit, new",
        r4,
    );
    row(
        5,
        "short names, id 1234, evm key (52), ETH.base, one base unit, new",
        r5,
    );
    row(6, "short names, all maxima: id 4294967295, near key (69), 12 character symbol, u128::MAX at 38 decimals, in_book", r6);
    assert_eq!([r1, r2, r3, r4, r5, r6], [266, 283, 226, 243, 164, 215]);

    // the 67 character id of an action index from 10 to 99 adds one byte to rows 3 and 4
    let r3b = short_json(&id67, key52, ETH_BASE, ONE_BASE_UNIT, WHY, "new")
        .to_string()
        .len();
    let r4b = short_json(&id67, &key69, ETH_BASE, ONE_BASE_UNIT, WHY, "new")
        .to_string()
        .len();
    assert_eq!((r3b, r4b), (227, 244));

    // decision (b): with the request id as `id` the arguments exceed 200 bytes even with the short names, so `id` is the pending number
    for spec_id_bytes in [r3, r4, r3b, r4b, r1, r2] {
        assert!(spec_id_bytes > LEDGER_LIMIT, "{spec_id_bytes}");
    }
    // the R4-12 figure of 164 needs the short pending number, and an amount of one whole ETH (`1`) gives 145
    assert!(r5 < LEDGER_LIMIT);
    let whole_eth = short_json("1234", key52, ETH_BASE, "1", WHY, "new")
        .to_string()
        .len();
    assert_eq!(whole_eth, 145);
}

#[test]
fn approve_args_len_equals_the_real_json_for_every_key_form() {
    let keys = [
        ("named near account of 64 characters", near_key_64()),
        (
            "near implicit account of 64 hex digits",
            format!("near:{}", "0123456789abcdef".repeat(4)),
        ),
        (
            "eth-implicit near account",
            format!("near:0x{}", "d8da6bf26964af9d7eed9e03e53415d37aa96045"),
        ),
        (
            "evm key with the largest chain id",
            format!(
                "evm:{}:0x{}",
                u64::MAX,
                "d8da6bf26964af9d7eed9e03e53415d37aa96045"
            ),
        ),
        ("demo evm key", DEMO_EVM_KEY.to_string()),
        ("short near key", "near:ab".to_string()),
    ];
    for (what, key) in &keys {
        for (id, symbol, amount, why, book) in [
            ("1", "A", "0", "NewRecipient", "new"),
            (
                "4294967295",
                "ABCDEFGHIJKL",
                "3.40282366920938463463374607431768211455",
                WHY,
                "in_book",
            ),
            ("1234", ETH_BASE, ONE_BASE_UNIT, "OverPayeeLimit", "in_book"),
        ] {
            let json = short_json(id, key, symbol, amount, why, book).to_string();
            assert_eq!(
                formula(id, key, symbol, amount, why, book),
                json.len(),
                "{what}: {json}"
            );
        }
    }
    // the longest key of each form is within MAX_TO, and the maxima are real
    for (what, key) in &keys {
        assert!(key.len() <= MAX_TO, "{what}: {} characters", key.len());
    }
    assert_eq!(MAX_TO, near_key_64().len());
    assert_eq!(
        format!("evm:{}:0x{}", u64::MAX, "0".repeat(40)).len(),
        4 + 20 + 3 + 40
    );
    assert_eq!(MAX_ID_DIGITS, u32::MAX.to_string().len());
    assert_eq!(MAX_WHY, WHY.len());
    assert_eq!(MAX_BOOK, "in_book".len());
    assert_eq!(MAX_SYMBOL, 12);
}

/// The guard length of an asset: the worst case over every amount up to the hard cap.
fn guard_len(symbol: &str, hard_cap: u128, decimals: u8) -> usize {
    approve_args_len(
        MAX_ID_DIGITS,
        MAX_TO,
        symbol.len(),
        amount_text_len(hard_cap, decimals),
        MAX_WHY,
        MAX_BOOK,
    )
}

#[test]
fn demo_registry_rows_stay_under_200() {
    let near = 10_000 * 10u128.pow(24);
    let eth = 10u128.pow(18);
    assert_eq!(guard_len("NEAR", near, 24), 197);
    assert_eq!(guard_len(ETH_BASE, eth, 18), 191);
    // NEAR registers up to 1,000,000 NEAR (199) and is refused at 10,000,000 NEAR (200)
    assert_eq!(guard_len("NEAR", 1_000_000 * 10u128.pow(24), 24), 199);
    assert_eq!(guard_len("NEAR", 10_000_000 * 10u128.pow(24), 24), 200);
    // the effective decimals ceiling is 33: symbol `A` and a hard cap of one whole unit gives 199 at 33 decimals and 200 at 34
    assert_eq!(guard_len("A", 10u128.pow(33), 33), 199);
    assert_eq!(guard_len("A", 10u128.pow(34), 34), 200);
    // the 12 character symbol at 38 decimals with a hard cap of 10^38 is the 40 character worst case
    assert_eq!(guard_len("ABCDEFGHIJKL", 10u128.pow(38), 38), 215);
    // the longest real amount of each demo asset keeps the arguments under the limit
    for (symbol, cap, decimals) in [("NEAR", near, 24u8), (ETH_BASE, eth, 18)] {
        let (buf, len) = decimal::format(cap - 1, decimals).expect("formats");
        let real = approve_args_len(MAX_ID_DIGITS, MAX_TO, symbol.len(), len, MAX_WHY, MAX_BOOK);
        assert!(real < LEDGER_LIMIT, "{symbol}: {real}");
        assert!(
            len <= amount_text_len(cap, decimals),
            "{symbol}: {len} against {}",
            amount_text_len(cap, decimals)
        );
        let _ = buf;
    }
}

/// The formula is an upper bound on the longest `decimal::format` text of any amount up to the hard cap, and exact except for one
/// character when the cap is an exact power of ten above one unit.
#[test]
fn amount_text_len_bounds_every_formatted_amount() {
    // every hard cap below 3,000 at 0 to 3 decimals: the longest text up to each cap against the formula
    for decimals in 0u8..=3 {
        let mut longest = 0usize;
        for amount in 0u128..3_000 {
            let (_, len) = decimal::format(amount, decimals).unwrap();
            longest = longest.max(len);
            let bound = amount_text_len(amount.max(1), decimals);
            assert!(
                longest <= bound,
                "cap {amount} at {decimals} decimals: longest {longest}, bound {bound}"
            );
        }
    }
    // 20,000 random hard caps and decimals (a fixed seed): the text of the cap, of the amount below it and of the largest amount with
    // every fraction digit non-zero must fit
    let mut state: u64 = 0x5eed_0086_0123_4567;
    let mut next = move || {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    for _ in 0..20_000 {
        let decimals = u8::try_from(next() % 39).unwrap();
        let bits = 1 + next() % 128;
        let cap = (u128::from(next()) << 64 | u128::from(next())) >> (128 - bits);
        let cap = cap.max(1);
        let bound = amount_text_len(cap, decimals);
        let step = 10u128.pow(u32::from(decimals));
        // the amount below the cap whose fraction is all nines (longest fraction), and the cap itself
        let nines = (cap / step).saturating_mul(step).saturating_sub(1).min(cap);
        for amount in [cap, cap - 1, nines] {
            let (_, len) = decimal::format(amount, decimals).unwrap();
            assert!(
                len <= bound,
                "cap {cap}, {decimals} decimals, amount {amount}: {len} against {bound}"
            );
        }
    }
    // pessimism: an exact power of ten above one unit is one character high
    assert_eq!(amount_text_len(10_000 * 10u128.pow(24), 24), 30);
    let (_, longest) = decimal::format(10_000 * 10u128.pow(24) - 1, 24).unwrap();
    assert_eq!(longest, 29);
    // below one unit the text is still `0.` and the fraction; above 38 decimals count as 38
    assert_eq!(amount_text_len(1, 24), 1 + 1 + 24);
    assert_eq!(amount_text_len(5, 0), 1);
    assert_eq!(amount_text_len(u128::MAX, 0), 39);
    assert_eq!(amount_text_len(u128::MAX, 38), 1 + 1 + 38);
    assert_eq!(
        amount_text_len(u128::MAX, 200),
        amount_text_len(u128::MAX, 38)
    );
    // the formatted cap is too short a measure: `10000` is 5 characters, the amount just below it has 29
    let (_, cap_len) = decimal::format(10_000 * 10u128.pow(24), 24).unwrap();
    assert_eq!(cap_len, 5);
}

#[test]
fn approve_args_len_saturates() {
    assert_eq!(approve_args_len(usize::MAX, 1, 1, 1, 1, 1), usize::MAX);
    assert_eq!(approve_args_len(0, 0, 0, 0, 0, 0), 59);
}
