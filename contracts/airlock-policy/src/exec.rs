// AIR-100: the EVM lane. An Executing record (an Allow, or an approved escalation) becomes an EIP-1559 transaction built inside the
// contract from the stored request and the registry, its keccak256 hash goes to the MPC signer, and `on_signed` (AIR-105) stores and
// announces the signature. Nothing the agent sent selects the path, the chain or the nonce, and one request id maps to at most one
// (path, nonce, bytes) triple (`evm_attempts`, AIR-104), so a retry re-signs the identical bytes and never makes a second transaction.
//
// Placement (security): `start_execution` and `start_evm` live in a plain `impl Contract`, so neither is an exported method
// (`tests/exec_evm.rs::exec_helpers_not_exported`). The module is `pub` and every helper is `pub` (see lib.rs).
use crate::nonces::EvmAttempt;
use crate::request::{ExecInfo, RequestState};
use crate::*;
use near_sdk::ext_contract;
use omni_transaction::{
    TxBuilder,
    evm::{EVMTransaction, EVMTransactionBuilder},
};

/// The signer requires at least 15 Tgas prepaid (live config); the template uses exactly 15.
pub const GAS_MPC_SIGN: Gas = Gas::from_tgas(15);
pub const GAS_ON_SIGNED: Gas = Gas::from_tgas(20);
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// Wire shape of the signer's argument: `{"request":{"path","payload_v2":{"Ecdsa":"<64 hex>"},"domain_id":0}}`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// The signer's interface; the parameter name `request` is the JSON key.
#[ext_contract(mpc)]
pub trait Mpc {
    fn sign(&mut self, request: SignRequest);
}

/// The unsigned EIP-1559 payload: `0x02` followed by the RLP list (empty data, empty access list). omni-transaction 0.5.0 takes the value,
/// the gas and the fees as `u128` and `to` as 20 bytes.
pub fn build_evm_unsigned(
    chain_id: u64,
    nonce: u64,
    to: [u8; 20],
    value: u128,
    gas_limit: u128,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
) -> Vec<u8> {
    let tx: EVMTransaction = EVMTransactionBuilder::new()
        .chain_id(chain_id)
        .nonce(nonce)
        .to(to)
        .value(value)
        .input(vec![])
        .gas_limit(gas_limit)
        .max_fee_per_gas(max_fee_per_gas)
        .max_priority_fee_per_gas(max_priority_fee_per_gas)
        .build();
    tx.build_for_signing()
}

/// The decimal chain id of `evm:<chain_id>:native` (the registry grammar guarantees it parses).
pub fn evm_chain_id(asset_id: &str) -> u64 {
    asset_id
        .split(':')
        .nth(1)
        .and_then(|part| part.parse().ok())
        .unwrap_or_else(|| env::panic_str("bad evm asset id"))
}

/// The 20 bytes of `evm:<chain_id>:0x<40 lowercase hex>`: its last 40 hex digits.
pub fn evm_to_address(payee_key: &str) -> [u8; 20] {
    let digits = payee_key
        .len()
        .checked_sub(40)
        .and_then(|from| payee_key.get(from..))
        .unwrap_or_else(|| env::panic_str("bad evm payee key"));
    let mut to = [0u8; 20];
    hex::decode_to_slice(digits, &mut to).unwrap_or_else(|_| env::panic_str("bad evm payee key"));
    to
}

impl Contract {
    /// The seam to the execution lanes (AIR-061): turns an `Executing` record into signing (EVM) or a transfer (NEAR, AIR-101) and
    /// returns the promise, which the caller detaches after every charge of its call is made. An arm whose lane has not landed returns
    /// `None`, and the record stays `Executing`. Plain `impl`: never exported.
    pub fn start_execution(&mut self, id: &str) -> Option<Promise> {
        let Some(asset) = self
            .records
            .get(id)
            .filter(|rec| rec.state == RequestState::Executing)
            .map(|rec| rec.asset.clone())
        else {
            env::panic_str("request is not executing")
        };
        match asset.as_str() {
            a if a.starts_with("evm:") => Some(self.start_evm(id)),
            _ => None,
        }
    }

    /// Builds (or, on a retry, rebuilds and checks) the transaction of an Executing EVM request, records and announces its bytes, and
    /// asks the signer to sign their hash, with `on_signed` as the callback. Everything comes from the stored record and the registry.
    /// A panic reverts the whole `submit_batch` (charges included) or leaves the escalation Pending (`approve`).
    pub fn start_evm(&mut self, id: &str) -> Promise {
        let mut rec = match self.records.get(id) {
            Some(rec) if rec.state == RequestState::Executing => rec.clone(),
            _ => env::panic_str("unexpected state"),
        };
        let asset = self
            .asset(&rec.asset)
            .unwrap_or_else(|| env::panic_str("unknown asset"));
        let path = asset
            .path
            .unwrap_or_else(|| env::panic_str("evm path missing"));
        let evm = rec
            .evm
            .unwrap_or_else(|| env::panic_str("evm params missing"));
        let build = |nonce: u64| {
            build_evm_unsigned(
                evm_chain_id(&rec.asset),
                nonce,
                evm_to_address(&rec.payee),
                rec.amount,
                evm.gas_limit.0,
                evm.max_fee_per_gas.0,
                evm.max_priority_fee_per_gas.0,
            )
        };
        let (bytes, unsigned_hex) = match self.attempt_of(id) {
            Some(attempt) => {
                // a retry: the first attempt's bytes are signed again, no new nonce is taken
                require!(attempt.path == path, "signing path changed");
                let rebuilt = build(attempt.nonce);
                require!(
                    hex::decode(&attempt.unsigned_hex).is_ok_and(|stored| stored == rebuilt),
                    "stored attempt does not match request"
                );
                (rebuilt, attempt.unsigned_hex)
            }
            None => {
                let nonce = self.next_nonce(&path);
                let bytes = build(nonce);
                let unsigned_hex = hex::encode(&bytes);
                self.record_attempt(
                    id,
                    EvmAttempt {
                        path: path.clone(),
                        nonce,
                        unsigned_hex: unsigned_hex.clone(),
                    },
                );
                (bytes, unsigned_hex)
            }
        };
        rec.exec = Some(ExecInfo {
            unsigned_hex: Some(unsigned_hex.clone()),
            ..ExecInfo::default()
        });
        self.records.insert(id.to_string(), rec);
        Event::EvmUnsigned {
            request_id: id,
            unsigned_hex: &unsigned_hex,
        }
        .emit();
        let hash: [u8; 32] = env::keccak256_array(&bytes);
        // `with_unused_gas_weight(0)`: the signer receives exactly GAS_MPC_SIGN, so AIR-107's reserved figure is exact
        mpc::ext(self.mpc_contract_id.clone())
            .with_static_gas(GAS_MPC_SIGN)
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_unused_gas_weight(0)
            .sign(SignRequest {
                path,
                payload_v2: Payload::Ecdsa(hex::encode(hash)),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SIGNED)
                    .on_signed(id.to_string(), unsigned_hex),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY1: &str = "02f183014a3480843b9aca00847735940082520894d8da6bf26964af9d7eed9e03e53415d37aa96045872386f26fc1000080c0";

    fn addr(byte: u8) -> [u8; 20] {
        [byte; 20]
    }

    #[test]
    fn exec_preimage_vector_day1() {
        let to = evm_to_address("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
        let bytes = build_evm_unsigned(
            84532,
            0,
            to,
            10u128.pow(16),
            21_000,
            2_000_000_000,
            1_000_000_000,
        );
        assert_eq!(hex::encode(bytes), DAY1);
    }

    #[test]
    fn exec_preimage_vector_small() {
        let bytes = build_evm_unsigned(
            84532,
            7,
            addr(0x11),
            10u128.pow(13),
            21_000,
            1_000_000_000,
            1_000_000,
        );
        assert_eq!(
            hex::encode(bytes),
            "02ef83014a3407830f4240843b9aca008252089411111111111111111111111111111111111111118609184e72a00080c0"
        );
        let bytes = build_evm_unsigned(1, 0, addr(0xab), 0, 21_000, 1, 0);
        assert_eq!(
            hex::encode(bytes),
            "02df0180800182520894abababababababababababababababababababab8080c0"
        );
    }

    #[test]
    fn exec_preimage_extremes() {
        let bytes = build_evm_unsigned(
            u64::MAX,
            u64::MAX,
            [0; 20],
            u128::MAX,
            u128::MAX,
            u128::MAX,
            u128::MAX,
        );
        assert_eq!(
            hex::encode(bytes),
            "02f86d88ffffffffffffffff88ffffffffffffffff90ffffffffffffffffffffffffffffffff90ffffffffffffffffffffffffffffffff90ffffffffffffffffffffffffffffffff94000000000000000000000000000000000000000090ffffffffffffffffffffffffffffffff80c0"
        );
    }

    #[test]
    fn exec_evm_chain_id() {
        assert_eq!(evm_chain_id("evm:84532:native"), 84532);
        assert_eq!(evm_chain_id("evm:1:native"), 1);
    }

    #[test]
    fn exec_evm_to_address() {
        let to = evm_to_address("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
        assert_eq!(hex::encode(to), "d8da6bf26964af9d7eed9e03e53415d37aa96045");
        let to = evm_to_address("evm:1:0xabababababababababababababababababababab");
        assert_eq!(to, addr(0xab));
    }
}
