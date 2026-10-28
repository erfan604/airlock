// fixture stand-in for scripts/derive-address.mjs: prints a fixed address per (account, path)
const table = {
  'policy.fixture-owner.testnet airlock-demo-1': '0x16c089aad87decf4eaaa4a4afeb5926bcd11b410',
  'airlock-spike.fixture-owner.testnet airlock-1': '0x59b0565b4e395e6ea202ca125c7d1a8e7afb8d21',
};
const key = process.argv.slice(2, 4).join(' ');
if (!(key in table)) { console.error('no fixture address for ' + key); process.exit(1); }
console.log(table[key]);
