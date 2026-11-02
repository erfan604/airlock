// The pinned NEAR Connect manifest: the one primary wallet AIR-260 marked, as a literal object (the library fetches nothing).
import snapshot from './manifest-snapshot.json' with { type: 'json' };

export const MANIFEST_SNAPSHOT = snapshot;

/** The id of the one wallet the console offers. */
export const PRIMARY_WALLET_ID: string = snapshot.wallets[0]?.id ?? '';
