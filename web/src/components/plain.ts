// The owner rule for visible web text: the word "testnet" is not printed. Text that comes from a data file (docs/proven.json) is rewritten where it is
// drawn, so the file itself stays as the proofs wrote it. Account names are not touched here: a name is an identifier, and an owner's own name has
// its own neutral label (components/account.ts).
export const plain = (text: string): string => text.replace(/\bon testnet\b/gi, 'on the test network').replace(/\btestnet\b/gi, 'test network');
