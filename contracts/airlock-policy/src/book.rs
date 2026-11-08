// The private address book (AIR-326, docs/design/private-book.md). The contract stores one Merkle root; a request that pays a book payee
// carries its entry and the path, and `verify` rebuilds the leaf from the request's own payee. Fixed depth, domain separated hashes.
use crate::policy::BookEntry;
use crate::request::Hex32;
use crate::*;
use near_sdk::json_types::U128;

/// Slots in the tree: 2^DEPTH. The depth is a constant, so a path of another length never verifies.
pub const DEPTH: usize = 8;
pub const SLOTS: usize = 1 << DEPTH;
const LEAF_TAG: &[u8] = b"\x00airlock-book-v1";
const NODE_TAG: u8 = 0x01;
const FILLER_TAG: u8 = 0x02;

/// One entry and its path, as a request carries it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookProof {
    pub salt: Hex32,
    pub cap: Option<U128>,
    pub daily_untrusted_budget: U128,
    pub daily_limit: U128,
    pub index: u8,
    pub siblings: Vec<Hex32>,
}

/// The leaf of an entry: a commitment to the salt, the payee key and the three numbers.
pub fn leaf_hash(
    salt: &[u8; 32],
    payee: &str,
    cap: Option<u128>,
    budget: u128,
    limit: u128,
) -> [u8; 32] {
    let mut b = Vec::with_capacity(LEAF_TAG.len() + 32 + 2 + payee.len() + 1 + 48);
    b.extend_from_slice(LEAF_TAG);
    b.extend_from_slice(salt);
    b.extend_from_slice(&(payee.len() as u16).to_be_bytes());
    b.extend_from_slice(payee.as_bytes());
    b.push(u8::from(cap.is_some()));
    b.extend_from_slice(&cap.unwrap_or(0).to_be_bytes());
    b.extend_from_slice(&budget.to_be_bytes());
    b.extend_from_slice(&limit.to_be_bytes());
    env::sha256_array(b)
}

pub fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut b = [0u8; 65];
    b[0] = NODE_TAG;
    b[1..33].copy_from_slice(left);
    b[33..].copy_from_slice(right);
    env::sha256_array(b)
}

/// A filler leaf for an unused slot: not an entry, never verified.
pub fn filler_leaf(random: &[u8; 32]) -> [u8; 32] {
    let mut b = [0u8; 33];
    b[0] = FILLER_TAG;
    b[1..].copy_from_slice(random);
    env::sha256_array(b)
}

/// The entry for `payee` when `proof` verifies against `root`, otherwise `None`. Never panics.
pub fn verify(root: &[u8; 32], payee: &str, proof: &BookProof) -> Option<BookEntry> {
    if proof.siblings.len() != DEPTH || payee.len() > u16::MAX as usize {
        return None;
    }
    let cap = proof.cap.map(|c| c.0);
    let mut h = leaf_hash(
        &proof.salt.0,
        payee,
        cap,
        proof.daily_untrusted_budget.0,
        proof.daily_limit.0,
    );
    for (level, sib) in proof.siblings.iter().enumerate() {
        h = if (proof.index >> level) & 1 == 0 {
            node_hash(&h, &sib.0)
        } else {
            node_hash(&sib.0, &h)
        };
    }
    if &h != root {
        return None;
    }
    Some(BookEntry {
        cap,
        daily_untrusted_budget: proof.daily_untrusted_budget.0,
        daily_limit: proof.daily_limit.0,
    })
}

/// One entry of an owner's book, for building a tree (tests and the bootstrap tools; the runtime has its own TypeScript builder).
#[derive(Clone, Debug)]
pub struct Entry {
    pub salt: [u8; 32],
    pub payee: String,
    pub cap: Option<u128>,
    pub daily_untrusted_budget: u128,
    pub daily_limit: u128,
}

/// The root and one proof per entry. Slot `i` holds entry `i`; every other slot is a filler derived from `seed` and the slot number.
pub fn build(entries: &[Entry], seed: &[u8; 32]) -> ([u8; 32], Vec<BookProof>) {
    assert!(entries.len() <= SLOTS, "too many entries");
    let mut level: Vec<[u8; 32]> = (0..SLOTS)
        .map(|i| match entries.get(i) {
            Some(e) => leaf_hash(
                &e.salt,
                &e.payee,
                e.cap,
                e.daily_untrusted_budget,
                e.daily_limit,
            ),
            None => {
                let r = env::sha256_array([&seed[..], &(i as u32).to_be_bytes()].concat());
                filler_leaf(&r)
            }
        })
        .collect();
    let mut layers = vec![level.clone()];
    while level.len() > 1 {
        level = level.chunks(2).map(|p| node_hash(&p[0], &p[1])).collect();
        layers.push(level.clone());
    }
    let root = layers[DEPTH][0];
    let proofs = entries
        .iter()
        .enumerate()
        .map(|(i, e)| BookProof {
            salt: Hex32(e.salt),
            cap: e.cap.map(U128),
            daily_untrusted_budget: U128(e.daily_untrusted_budget),
            daily_limit: U128(e.daily_limit),
            index: i as u8,
            siblings: (0..DEPTH).map(|l| Hex32(layers[l][(i >> l) ^ 1])).collect(),
        })
        .collect();
    (root, proofs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    fn entries(n: usize) -> Vec<Entry> {
        (0..n)
            .map(|i| Entry {
                salt: [(i as u8).wrapping_add(1); 32],
                payee: format!("near:payee{i:03}.test.near"),
                cap: if i % 2 == 0 {
                    Some(100 + i as u128)
                } else {
                    None
                },
                daily_untrusted_budget: 1_000 + i as u128,
                daily_limit: 5_000 + i as u128,
            })
            .collect()
    }

    #[test]
    fn book_every_committed_entry_verifies_with_its_own_numbers() {
        fresh();
        for n in [1usize, 2, 7, 64, 256] {
            let es = entries(n);
            let (root, proofs) = build(&es, &[9; 32]);
            for (e, p) in es.iter().zip(&proofs) {
                let got = verify(&root, &e.payee, p).expect("member");
                assert_eq!(got.cap, e.cap);
                assert_eq!(got.daily_untrusted_budget, e.daily_untrusted_budget);
                assert_eq!(got.daily_limit, e.daily_limit);
            }
        }
    }

    #[test]
    fn book_a_proof_fails_for_another_payee_number_index_path_or_root() {
        fresh();
        let es = entries(5);
        let (root, proofs) = build(&es, &[9; 32]);
        let p = proofs[2].clone();
        let name = &es[2].payee;
        assert!(verify(&root, name, &p).is_some());
        assert!(verify(&root, &es[3].payee, &p).is_none());
        let mut q = p.clone();
        q.cap = Some(U128(1));
        assert!(verify(&root, name, &q).is_none());
        let mut q = p.clone();
        q.daily_limit = U128(q.daily_limit.0 + 1);
        assert!(verify(&root, name, &q).is_none());
        let mut q = p.clone();
        q.daily_untrusted_budget = U128(q.daily_untrusted_budget.0 + 1);
        assert!(verify(&root, name, &q).is_none());
        let mut q = p.clone();
        q.index ^= 1;
        assert!(verify(&root, name, &q).is_none());
        let mut q = p.clone();
        q.salt = Hex32([7; 32]);
        assert!(verify(&root, name, &q).is_none());
        let mut q = p.clone();
        q.siblings[3].0[0] ^= 1;
        assert!(verify(&root, name, &q).is_none());
        let mut q = p.clone();
        q.siblings.pop();
        assert!(verify(&root, name, &q).is_none());
        let mut q = p.clone();
        q.siblings.push(Hex32([0; 32]));
        assert!(verify(&root, name, &q).is_none());
        let mut other = root;
        other[31] ^= 1;
        assert!(verify(&other, name, &p).is_none());
    }

    #[test]
    fn book_an_inner_node_is_not_a_leaf() {
        fresh();
        let es = entries(4);
        let (root, proofs) = build(&es, &[9; 32]);
        // a proof whose "leaf" would have to equal an inner node cannot be made: the leaf tag differs from the node tag
        let a = leaf_hash(&[1; 32], "near:a.test.near", None, 0, 0);
        let b = leaf_hash(&[2; 32], "near:b.test.near", None, 0, 0);
        assert_ne!(node_hash(&a, &b), a);
        assert!(verify(&root, "near:payee000.test.near", &proofs[1]).is_none());
    }

    #[test]
    fn book_filler_slots_hide_the_count() {
        fresh();
        let (r1, _) = build(&entries(1), &[1; 32]);
        let (r2, _) = build(&entries(1), &[2; 32]);
        assert_ne!(r1, r2, "the filler seed changes the root");
        let (_, p) = build(&entries(3), &[1; 32]);
        assert_eq!(p[0].siblings.len(), DEPTH);
    }
}
