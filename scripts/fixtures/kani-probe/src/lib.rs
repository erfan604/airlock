#![cfg_attr(not(test), no_std)]
pub fn add(a: u8, b: u8) -> Option<u8> { a.checked_add(b) }
#[cfg(kani)]
mod proofs {
    use super::*;
    #[kani::proof] fn ok_with_cover() {
        let (a, b): (u8, u8) = (kani::any(), kani::any());
        let r = add(a, b);
        kani::cover!(r.is_some(), "sum fits"); kani::cover!(r.is_none(), "sum overflows");
        if let Some(s) = r { assert!(s >= a); }
    }
    #[kani::proof] fn unsat_cover() { let a: u8 = kani::any(); kani::assume(a < 10); kani::cover!(a > 20, "never"); kani::cover!(a < 5, "small"); }
    #[kani::proof] fn unreachable_cover() {
        let a: u8 = kani::any();
        if a > 10 && a < 5 { kani::cover!(true, "dead branch"); }
        kani::cover!(a == 3, "three");
    }
    #[kani::proof] fn no_checks() { let _a: u8 = kani::any(); }
    #[kani::proof] #[kani::should_panic] fn expected_failure() { let a: u8 = kani::any(); assert!(a < 200, "A naive thing exceeds the bound"); }
    #[kani::proof] #[kani::should_panic] fn wrong_failure() {
        let a: u8 = kani::any();
        assert!(a < 100, "some other message");
        assert!(a < 200, "A naive thing exceeds the bound");
    }
    #[kani::proof] #[kani::should_panic] fn should_panic_but_passes() { let a: u8 = kani::any(); assert!(a == a, "A tautology"); }
    #[kani::proof] fn plain_failure() { let a: u8 = kani::any(); assert!(a < 255, "plain fail"); }
}
