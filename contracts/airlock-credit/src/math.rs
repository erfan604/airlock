// The integer math of the pool (AIR-328, docs/design/credit.md). No floats. Every product goes through a 256 bit intermediate, because
// assets times shares overflows u128 at NEAR scale (1e24 yocto per NEAR). Rounding always favours the pool: shares floor on deposit,
// amounts floor on withdraw, fees ceil.

/// `a * b` as a 256 bit number `(high, low)`.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a0, a1) = (a & u128::from(u64::MAX), a >> 64);
    let (b0, b1) = (b & u128::from(u64::MAX), b >> 64);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & u128::from(u64::MAX)) + (p10 & u128::from(u64::MAX));
    let low = (p00 & u128::from(u64::MAX)) | (mid << 64);
    let high = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (high, low)
}

/// `(high, low) / d` and the remainder, `None` when the quotient does not fit in u128 or `d` is 0.
fn div_wide(high: u128, low: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 || high >= d {
        return None;
    }
    // bitwise long division of the 256 bit number by d; the running remainder stays below d
    let mut rem = high;
    let mut quo = 0u128;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((low >> i) & 1);
        quo <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            quo |= 1;
        }
    }
    Some((quo, rem))
}

/// `floor(a * b / d)`, `None` on overflow or `d == 0`.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    let (h, l) = mul_wide(a, b);
    div_wide(h, l, d).map(|(q, _)| q)
}

/// `ceil(a * b / d)`, `None` on overflow or `d == 0`.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let (h, l) = mul_wide(a, b);
    let (q, r) = div_wide(h, l, d)?;
    if r == 0 { Some(q) } else { q.checked_add(1) }
}

/// Shares minted for `amount` at the current price: the first deposit 1:1, then `floor(amount * shares / assets)`. `None` when the pool
/// has shares but no assets (every share was lost) or on overflow.
pub fn shares_for_deposit(amount: u128, total_shares: u128, assets: u128) -> Option<u128> {
    if total_shares == 0 {
        return Some(amount);
    }
    if assets == 0 {
        return None;
    }
    mul_div_floor(amount, total_shares, assets)
}

/// What `shares` are worth: `floor(shares * assets / total_shares)`.
pub fn amount_for_shares(shares: u128, total_shares: u128, assets: u128) -> Option<u128> {
    if total_shares == 0 {
        return Some(0);
    }
    mul_div_floor(shares, assets, total_shares)
}

/// The fee of `outstanding` at `fee_bps`: `ceil(outstanding * fee_bps / 10000)`.
pub fn fee_of(outstanding: u128, fee_bps: u32) -> Option<u128> {
    mul_div_ceil(outstanding, u128::from(fee_bps), 10_000)
}

/// The collateral a line of `limit` needs: `ceil(limit * collateral_bps / 10000)`.
pub fn collateral_needed(limit: u128, collateral_bps: u32) -> Option<u128> {
    mul_div_ceil(limit, u128::from(collateral_bps), 10_000)
}

/// The price of one share in yoctoNEAR scaled by 10^24 (1.0 is 10^24); 10^24 when there are no shares.
pub fn share_price(assets: u128, total_shares: u128) -> Option<u128> {
    if total_shares == 0 {
        return Some(1_000_000_000_000_000_000_000_000);
    }
    mul_div_floor(assets, 1_000_000_000_000_000_000_000_000, total_shares)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn mul_div_matches_u128_on_small_numbers() {
        for (a, b, d) in [
            (7u128, 9u128, 4u128),
            (0, 5, 3),
            (10, 10, 100),
            (u64::MAX as u128, 3, 7),
        ] {
            assert_eq!(mul_div_floor(a, b, d), Some(a * b / d), "{a} {b} {d}");
            assert_eq!(
                mul_div_ceil(a, b, d),
                Some((a * b).div_ceil(d)),
                "{a} {b} {d}"
            );
        }
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn mul_div_survives_products_above_u128() {
        // 1e9 NEAR times 1e9 NEAR is 1e66, far above u128 (3.4e38)
        let big = 1_000_000_000 * NEAR;
        assert_eq!(mul_div_floor(big, big, big), Some(big));
        assert_eq!(mul_div_floor(big, 2 * big, big), Some(2 * big));
        assert_eq!(mul_div_ceil(big, big - 1, big), Some(big - 1));
        // a quotient that does not fit is refused, not wrapped
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, 1), None);
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), None);
        assert_eq!(
            mul_div_floor(u128::MAX, u128::MAX, u128::MAX),
            Some(u128::MAX)
        );
    }

    #[test]
    fn floor_and_ceil_bracket_the_exact_quotient() {
        let mut x: u128 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..2_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let (a, b, d) = (
                x % (10 * NEAR) + 1,
                (x >> 3) % (10 * NEAR) + 1,
                (x >> 5) % (10 * NEAR) + 1,
            );
            let f = mul_div_floor(a, b, d).unwrap();
            let c = mul_div_ceil(a, b, d).unwrap();
            assert!(c == f || c == f + 1);
            // f * d <= a * b < (f + 1) * d, checked with the wide product
            let (h1, l1) = mul_wide(f, d);
            let (h2, l2) = mul_wide(a, b);
            assert!((h1, l1) <= (h2, l2));
            let (h3, l3) = mul_wide(f + 1, d);
            assert!((h2, l2) < (h3, l3));
        }
    }

    #[test]
    fn first_deposit_is_one_to_one_and_later_ones_round_down() {
        assert_eq!(shares_for_deposit(5 * NEAR, 0, 0), Some(5 * NEAR));
        // price 1.5: 3 NEAR buys 2 NEAR of shares
        assert_eq!(
            shares_for_deposit(3 * NEAR, 100 * NEAR, 150 * NEAR),
            Some(2 * NEAR)
        );
        // 1 yocto at a price above 1 buys 0 shares (the call refuses a zero mint)
        assert_eq!(shares_for_deposit(1, 100 * NEAR, 150 * NEAR), Some(0));
        // shares outstanding but no assets: nothing can be priced
        assert_eq!(shares_for_deposit(NEAR, 100 * NEAR, 0), None);
    }

    #[test]
    fn withdraw_rounds_down_and_never_pays_more_than_pro_rata() {
        assert_eq!(
            amount_for_shares(2 * NEAR, 100 * NEAR, 150 * NEAR),
            Some(3 * NEAR)
        );
        assert_eq!(amount_for_shares(1, 3, 10), Some(3));
        assert_eq!(amount_for_shares(3, 3, 10), Some(10));
        assert_eq!(amount_for_shares(5, 0, 0), Some(0));
    }

    #[test]
    fn deposit_then_withdraw_never_gains() {
        let (shares, assets) = (7 * NEAR + 13, 11 * NEAR + 5);
        for amount in [1u128, 2, 3, 999, NEAR, 3 * NEAR + 1] {
            let minted = shares_for_deposit(amount, shares, assets).unwrap();
            let back = amount_for_shares(minted, shares + minted, assets + amount).unwrap();
            assert!(back <= amount, "{amount}: got {back}");
        }
    }

    #[test]
    fn fee_and_collateral_round_up() {
        assert_eq!(fee_of(10_000, 100), Some(100));
        assert_eq!(fee_of(1, 1), Some(1));
        assert_eq!(fee_of(0, 5000), Some(0));
        assert_eq!(collateral_needed(10_000, 3000), Some(3000));
        assert_eq!(collateral_needed(1, 3000), Some(1));
        assert_eq!(collateral_needed(5, 0), Some(0));
    }

    #[test]
    fn share_price_is_scaled_by_1e24() {
        assert_eq!(share_price(0, 0), Some(NEAR));
        assert_eq!(share_price(150 * NEAR, 100 * NEAR), Some(NEAR * 3 / 2));
        assert_eq!(share_price(99 * NEAR, 100 * NEAR), Some(NEAR * 99 / 100));
    }
}
