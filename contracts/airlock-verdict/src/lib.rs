//! The AIRLOCK on-chain verdict as a pure function (SPEC 8.3, "Verdict v3", rules 0 to 12).
//!
//! `no_std`, zero dependencies and no arithmetic: every check is a comparison, so the function cannot overflow, panic or
//! allocate. The contract loads the asset limits, the payee entry, the task scope for this (task, payee) and the flags from
//! storage, calls [`verdict`] and acts on the result. Kani (AIR-021) and the Lean model (AIR-022) check this same function.
//!
//! `cfg_attr(not(test), no_std)` is load-bearing: under plain `no_std` Kani reports every `assert!` message as a placeholder.
#![cfg_attr(not(test), no_std)]

/// Origin labels of the three authority-bearing values of one request, each a bitmask over the constants below.
/// There is no trigger field: pc starts at the label of the run trigger (SPEC R5-02).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Labels {
    pub recipient: u16,
    pub amount: u16,
    pub pc: u16,
}

pub const OWNER: u16 = 1 << 0;
pub const BOOK: u16 = 1 << 1;
pub const POLICY: u16 = 1 << 2;
pub const ORACLE: u16 = 1 << 3;
pub const UNRESOLVED: u16 = 1 << 4;
// Bits 5 to 14 are the untrusted channels; AIR-024 names them and writes the shared vector file.
/// Bits 4 to 14: every untrusted channel, Unresolved included.
pub const UNTRUSTED_MASK: u16 = 0b111_1111_1111 << 4;
/// Labels a value (amount or pc) may carry and still be trusted. Oracle is for numbers (SPEC R5-03).
pub const TRUSTED_MASK: u16 = OWNER | BOOK | POLICY | ORACLE;
/// Labels a recipient may carry and still be trusted: never Oracle, which is for numbers, not addresses.
pub const RECIPIENT_TRUSTED: u16 = OWNER | BOOK | POLICY;

/// A recipient label set is trusted when it is non-empty and within {Owner, Book, Policy}.
pub fn recipient_trusted(l: u16) -> bool {
    l != 0 && l & !RECIPIENT_TRUSTED == 0
}

/// An amount label set is trusted when it is non-empty and within {Owner, Book, Policy, Oracle}.
/// The pc rule is `labels.pc & !TRUSTED_MASK != 0`.
pub fn value_trusted(l: u16) -> bool {
    l != 0 && l & !TRUSTED_MASK == 0
}

/// One payment request. `fee_per_gas` and `gas` are `None` on the NEAR lane; `None` skips rule 3, so the contract must
/// supply `Some` for every EVM asset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub amount: u128,
    pub fee_per_gas: Option<u128>,
    pub gas: Option<u128>,
    pub labels: Labels,
}

/// Owner-registered limits for one asset (NEAR, a NEP-141 token, native ETH on one EVM chain).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssetLimits {
    pub hard_cap: u128,
    pub remaining_daily: u128,
    pub max_fee_per_gas: u128,
    pub max_gas: u128,
}

/// An address-book entry. `cap`: the largest single untrusted amount the owner accepts for this payee (`None`: never, which
/// is also how strict configuration is expressed); `budget_remaining`: what is left of today's untrusted-amount budget;
/// `limit_remaining`: what is left of today's limit for any amount, trusted or not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payee {
    pub cap: Option<u128>,
    pub budget_remaining: u128,
    pub limit_remaining: u128,
}

/// What is left of the owner-signed task bound for this (task, payee). `None` for the whole scope means the request is
/// outside every bound of the task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskScope {
    pub remaining: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flags {
    pub paused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Escalate(Reason),
    Block(Reason),
}

/// Why a request did not pass. The first 14 are returned by [`verdict`]; the last three (F02 3.3, SPEC R5-08) are returned
/// only by the flood model (AIR-082), never by `verdict`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    UnknownAsset,
    Paused,
    AmountOutOfBounds,
    DailyLimit,
    FeeTooHigh,
    MissingProvenance,
    BookLabelNotInBook,
    OutsideTask,
    OverTaskBound,
    UntrustedTrigger,
    UntrustedRecipient,
    NewRecipient,
    OverPayeeLimit,
    UntrustedAmount,
    PendingFull,
    EscalationsLocked,
    EscalationBudget,
}

pub const ALL_REASONS: [Reason; 17] = [
    Reason::UnknownAsset,
    Reason::Paused,
    Reason::AmountOutOfBounds,
    Reason::DailyLimit,
    Reason::FeeTooHigh,
    Reason::MissingProvenance,
    Reason::BookLabelNotInBook,
    Reason::OutsideTask,
    Reason::OverTaskBound,
    Reason::UntrustedTrigger,
    Reason::UntrustedRecipient,
    Reason::NewRecipient,
    Reason::OverPayeeLimit,
    Reason::UntrustedAmount,
    Reason::PendingFull,
    Reason::EscalationsLocked,
    Reason::EscalationBudget,
];

impl Reason {
    /// The variant name, exactly. This string is stable API: `approve` compares it (AIR-026, F03 3.1) and the differential
    /// driver prints it.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::UnknownAsset => "UnknownAsset",
            Reason::Paused => "Paused",
            Reason::AmountOutOfBounds => "AmountOutOfBounds",
            Reason::DailyLimit => "DailyLimit",
            Reason::FeeTooHigh => "FeeTooHigh",
            Reason::MissingProvenance => "MissingProvenance",
            Reason::BookLabelNotInBook => "BookLabelNotInBook",
            Reason::OutsideTask => "OutsideTask",
            Reason::OverTaskBound => "OverTaskBound",
            Reason::UntrustedTrigger => "UntrustedTrigger",
            Reason::UntrustedRecipient => "UntrustedRecipient",
            Reason::NewRecipient => "NewRecipient",
            Reason::OverPayeeLimit => "OverPayeeLimit",
            Reason::UntrustedAmount => "UntrustedAmount",
            Reason::PendingFull => "PendingFull",
            Reason::EscalationsLocked => "EscalationsLocked",
            Reason::EscalationBudget => "EscalationBudget",
        }
    }
}

/// True when `x` is present and above `cap`; an absent value never exceeds anything (rule 3 on the NEAR lane).
fn over(x: Option<u128>, cap: u128) -> bool {
    matches!(x, Some(v) if v > cap)
}

/// Rules 0 to 12 of SPEC 8.3, in order, first match wins.
pub fn verdict(
    req: &Request,
    asset: Option<AssetLimits>,
    payee: Option<Payee>,
    task: Option<TaskScope>,
    flags: &Flags,
) -> Verdict {
    // Rule 0: the asset is not in the owner's registry.
    let a = match asset {
        None => return Verdict::Block(Reason::UnknownAsset),
        Some(a) => a,
    };
    // Rule 1: paused.
    if flags.paused {
        return Verdict::Block(Reason::Paused);
    }
    // Rule 2: amount 0, over the hard cap, or over the remaining daily cap.
    if req.amount == 0 || req.amount > a.hard_cap {
        return Verdict::Block(Reason::AmountOutOfBounds);
    }
    if req.amount > a.remaining_daily {
        return Verdict::Block(Reason::DailyLimit);
    }
    // Rule 3: EVM fee or gas over the asset's limits (None skips the check).
    if over(req.fee_per_gas, a.max_fee_per_gas) || over(req.gas, a.max_gas) {
        return Verdict::Block(Reason::FeeTooHigh);
    }
    // Rule 4: an empty label set for the recipient, the amount or the pc.
    let l = req.labels;
    if l.recipient == 0 || l.amount == 0 || l.pc == 0 {
        return Verdict::Block(Reason::MissingProvenance);
    }
    // Rule 5: labelled Book but not in the on-chain book (a lying runtime).
    if l.recipient & BOOK != 0 && payee.is_none() {
        return Verdict::Block(Reason::BookLabelNotInBook);
    }
    // Rule 6: outside every bound of the owner-signed task, or above what is left of that bound.
    let t = match task {
        None => return Verdict::Escalate(Reason::OutsideTask),
        Some(t) => t,
    };
    if req.amount > t.remaining {
        return Verdict::Escalate(Reason::OverTaskBound);
    }
    // Rule 7: the pc carries a label that is not trusted.
    if l.pc & !TRUSTED_MASK != 0 {
        return Verdict::Escalate(Reason::UntrustedTrigger);
    }
    // Rule 8: the recipient labels are not within {Owner, Book, Policy}.
    if !recipient_trusted(l.recipient) {
        return Verdict::Escalate(Reason::UntrustedRecipient);
    }
    // Rule 9: the recipient is not in the book: always escalate.
    let p = match payee {
        None => return Verdict::Escalate(Reason::NewRecipient),
        Some(p) => p,
    };
    // Rule 10: above what is left of the payee's daily limit, for any amount.
    if req.amount > p.limit_remaining {
        return Verdict::Escalate(Reason::OverPayeeLimit);
    }
    // Rule 11: an untrusted amount passes only if it is not Unresolved, the payee has a cap, and the amount is within the
    // cap and within the payee's remaining untrusted budget.
    if !value_trusted(l.amount) {
        let unresolved = l.amount & UNRESOLVED != 0;
        return match p.cap {
            Some(cap) if !unresolved && req.amount <= cap && req.amount <= p.budget_remaining => {
                Verdict::Allow
            }
            _ => Verdict::Escalate(Reason::UntrustedAmount),
        };
    }
    // Rule 12.
    Verdict::Allow
}

#[cfg(kani)]
mod proofs;

pub mod labels;

pub mod ledger;

pub mod decimal;

pub mod approve;

pub mod flood;
pub mod keys;
