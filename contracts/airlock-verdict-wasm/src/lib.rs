//! AIR-311: `airlock_verdict::verdict`, the function the policy contract runs, as a WebAssembly module for the console's Try page.
//!
//! The caller writes the 21 columns of one case into the input buffer (`input_ptr`, 21 little-endian u128 values in the column order of
//! `contracts/airlock-verdict/examples/diff.rs` and `fixtures/verdict-vectors.lines`) and calls `run`, which returns one code:
//! `0` Allow, `0x100 + i` Escalate and `0x200 + i` Block with `i` the index of the reason in `ALL_REASONS`, and `0xFFFF` for a case
//! outside the domain (a kind or the paused flag above 1, a label mask of 2^16 or more), the `error:malformed` of the diff driver.
//! Nothing is imported, nothing is allocated and the module keeps no state between calls beyond the buffer.
#![cfg_attr(target_arch = "wasm32", no_std)]

use airlock_verdict::{
    verdict, AssetLimits, Flags, Labels, Payee, Request, TaskScope, Verdict, ALL_REASONS,
};

/// Columns of one case: amount, fee_kind, fee, gas_kind, gas, recipient, amount_labels, pc, asset_kind, hard_cap, remaining_daily,
/// max_fee, max_gas, payee_kind, cap_kind, cap, budget, limit, task_kind, remaining, paused.
pub const COLUMNS: usize = 21;
pub const MALFORMED: u32 = 0xFFFF;
const ESCALATE: u32 = 0x100;
const BLOCK: u32 = 0x200;

static mut INPUT: [u8; COLUMNS * 16] = [0; COLUMNS * 16];

/// Where the caller writes the 336 input bytes.
#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(INPUT).cast()
}

/// The verdict of the case in the input buffer.
#[no_mangle]
pub extern "C" fn run() -> u32 {
    // a copy by raw pointer, so no reference to the mutable static is ever made
    let bytes: [u8; COLUMNS * 16] = unsafe { core::ptr::addr_of!(INPUT).read() };
    let mut x = [0u128; COLUMNS];
    for (i, slot) in x.iter_mut().enumerate() {
        let mut b = [0u8; 16];
        b.copy_from_slice(&bytes[i * 16..i * 16 + 16]);
        *slot = u128::from_le_bytes(b);
    }
    decide(&x)
}

fn reason_index(r: airlock_verdict::Reason) -> u32 {
    for (i, candidate) in (0u32..).zip(ALL_REASONS) {
        if candidate == r {
            return i;
        }
    }
    0xFF
}

/// The same mapping from columns to arguments as the diff driver (examples/diff.rs), then the code of the verdict.
pub fn decide(x: &[u128; COLUMNS]) -> u32 {
    let flags_ok = [1, 3, 8, 13, 14, 18, 20].iter().all(|&i| x[i] <= 1);
    let (Ok(recipient), Ok(amount_labels), Ok(pc)) = (
        u16::try_from(x[5]),
        u16::try_from(x[6]),
        u16::try_from(x[7]),
    ) else {
        return MALFORMED;
    };
    if !flags_ok {
        return MALFORMED;
    }
    let opt = |k: usize, v: usize| (x[k] == 1).then_some(x[v]);
    let req = Request {
        amount: x[0],
        fee_per_gas: opt(1, 2),
        gas: opt(3, 4),
        labels: Labels {
            recipient,
            amount: amount_labels,
            pc,
        },
    };
    let asset = (x[8] == 1).then_some(AssetLimits {
        hard_cap: x[9],
        remaining_daily: x[10],
        max_fee_per_gas: x[11],
        max_gas: x[12],
    });
    let payee = (x[13] == 1).then_some(Payee {
        cap: opt(14, 15),
        budget_remaining: x[16],
        limit_remaining: x[17],
    });
    let task = (x[18] == 1).then_some(TaskScope { remaining: x[19] });
    match verdict(&req, asset, payee, task, &Flags { paused: x[20] == 1 }) {
        Verdict::Allow => 0,
        Verdict::Escalate(r) => ESCALATE + reason_index(r),
        Verdict::Block(r) => BLOCK + reason_index(r),
    }
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/verdict-vectors.lines"
    ));
    const EXPECT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/verdict-vectors.expect"
    ));

    fn tag(code: u32) -> String {
        if code == MALFORMED {
            return "error:malformed".to_string();
        }
        let kind = match code >> 8 {
            0 => return "allow".to_string(),
            1 => "escalate",
            2 => "block",
            _ => return format!("bad:{code}"),
        };
        format!("{kind}:{}", ALL_REASONS[(code & 0xFF) as usize].as_str())
    }

    fn columns(line: &str) -> [u128; COLUMNS] {
        let mut x = [0u128; COLUMNS];
        for (slot, t) in x.iter_mut().zip(line.split_whitespace()) {
            *slot = t.parse().unwrap();
        }
        x
    }

    #[test]
    fn the_shared_verdict_vectors_give_their_expected_tags() {
        let lines: Vec<&str> = LINES.lines().collect();
        let expect: Vec<&str> = EXPECT.lines().collect();
        assert_eq!(lines.len(), 200);
        assert_eq!(lines.len(), expect.len());
        for (i, (l, e)) in lines.iter().zip(expect.iter()).enumerate() {
            assert_eq!(tag(decide(&columns(l))), *e, "line {}", i + 1);
        }
    }

    #[test]
    fn the_input_buffer_round_trips_one_case() {
        let x = columns(LINES.lines().next().unwrap());
        let p = input_ptr();
        for (i, v) in x.iter().enumerate() {
            for (j, b) in v.to_le_bytes().iter().enumerate() {
                unsafe { p.add(i * 16 + j).write(*b) };
            }
        }
        assert_eq!(run(), decide(&x));
    }

    #[test]
    fn a_case_outside_the_domain_is_malformed() {
        let mut x = columns(LINES.lines().next().unwrap());
        x[20] = 2;
        assert_eq!(decide(&x), MALFORMED);
        let mut y = columns(LINES.lines().next().unwrap());
        y[5] = 1 << 16;
        assert_eq!(decide(&y), MALFORMED);
    }
}
