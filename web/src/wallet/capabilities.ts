// What each wallet shows before it signs (notes/wallet_display_2026-10-21.md section 0 and AIR-260's RESULTS.md, read from the screenshots).
// Keyed by the manifest `id`. The console offers only a wallet that shows the arguments; every id not in the table is refused.
export type WalletCapability = {
  shows_args: 'after_tap' | 'details' | 'device' | 'verbatim' | 'never';
  shows_deposit: 'exact' | 'rounds_to_zero';
  /** The exact words the console shows above the card, naming the tap that reveals the arguments. */
  howToReveal: string;
  signatureEncoding: 'base64' | 'unknown';
  allowed: boolean;
};

export const WALLET_CAPABILITIES: Record<string, WalletCapability> = {
  // the primary wallet (AIR-260): method and exact deposit on the first screen, the arguments one tap away
  'intear-wallet': {
    shows_args: 'after_tap',
    shows_deposit: 'exact',
    howToReveal: 'Tap Show args in Intear and compare the five values',
    signatureEncoding: 'base64',
    allowed: true,
  },
  // the backup of AIR-260 is measured but not offered (cut by the 2026-10-22 trim); its row is the data of the Meteor trap
  'meteor-wallet': {
    shows_args: 'details',
    shows_deposit: 'rounds_to_zero',
    howToReveal: 'Tap View Transaction Details and compare the five values under Args; the 1 yoctoNEAR deposit shows as 0, that is expected',
    signatureEncoding: 'base64',
    allowed: false,
  },
  // never shows the arguments
  'nightly-wallet': { shows_args: 'never', shows_deposit: 'rounds_to_zero', howToReveal: '', signatureEncoding: 'unknown', allowed: false },
};

/** The row of a wallet the console may use, or null: unknown ids, ids that only inherit a name, rows not allowed and `never` rows. */
export function allowedWallet(id: string): WalletCapability | null {
  if (!Object.hasOwn(WALLET_CAPABILITIES, id)) return null;
  const row = WALLET_CAPABILITIES[id];
  if (row === undefined || !row.allowed || row.shows_args === 'never') return null;
  return row;
}

/** The words shown above the confirm sheet; empty for a wallet that is not allowed. */
export function revealInstruction(id: string): string {
  return allowedWallet(id)?.howToReveal ?? '';
}
