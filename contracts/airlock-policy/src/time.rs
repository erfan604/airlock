//! UTC time only (AIR-062, F13 rule 5): every window is the block timestamp in milliseconds since the epoch divided by a fixed number of
//! milliseconds, with integer division. There is no local time and no offset anywhere in the contract. The ledgers of AIR-062 key
//! their buckets by `utc_day`, the escalation flood counters of AIR-083 by `utc_hour` (and `utc_day` for the reject counter).

pub const MS_PER_DAY: u64 = 86_400_000;
pub const MS_PER_HOUR: u64 = 3_600_000;

/// The UTC day number of a block timestamp in milliseconds: day 0 is 1970-01-01 00:00:00.000 UTC up to and including its last millisecond.
pub fn utc_day(ms: u64) -> u64 {
    ms / MS_PER_DAY
}

/// The UTC hour number (hours since the epoch) of a block timestamp in milliseconds.
pub fn utc_hour(ms: u64) -> u64 {
    ms / MS_PER_HOUR
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_day_changes_at_the_exact_millisecond() {
        assert_eq!(utc_day(0), 0);
        assert_eq!(utc_day(86_399_999), 0);
        assert_eq!(utc_day(86_400_000), 1);
        assert_eq!(utc_day(172_799_999), 1);
        assert_eq!(utc_day(172_800_000), 2);
    }

    #[test]
    fn utc_hour_changes_at_the_exact_millisecond() {
        assert_eq!(utc_hour(0), 0);
        assert_eq!(utc_hour(3_599_999), 0);
        assert_eq!(utc_hour(3_600_000), 1);
        assert_eq!(utc_hour(86_399_999), 23);
        assert_eq!(utc_hour(86_400_000), 24);
    }

    #[test]
    fn the_largest_timestamp_does_not_overflow() {
        assert_eq!(utc_day(u64::MAX), u64::MAX / 86_400_000);
        assert_eq!(utc_hour(u64::MAX), u64::MAX / 3_600_000);
    }

    #[test]
    fn a_real_date_lands_on_its_day() {
        // 2026-10-28 00:00:00 UTC is 1,793,145,600 s after the epoch
        let midnight = 1_793_145_600_000u64;
        assert_eq!(utc_day(midnight) * MS_PER_DAY, midnight);
        assert_eq!(utc_day(midnight - 1), utc_day(midnight) - 1);
        assert_eq!(utc_hour(midnight + 7 * MS_PER_HOUR) - utc_hour(midnight), 7);
    }
}
