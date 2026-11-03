// The visitor's stable key and the short form the log shows. Both are HMACs under a secret that is random, held in this process only and
// replaced every UTC day: nothing derived from the date or from the address alone can be recomputed outside, so an address cannot be brute
// forced back out of the 8 hex characters the public feed shows (there are only 2^32 IPv4 addresses).
import { createHmac, randomBytes } from 'node:crypto';

export class DailySalt {
  private day = '';
  private secret = '';

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {}

  /** The secret of today (64 hex characters); a new one after UTC midnight. The previous one is not kept. */
  current(): string {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.secret = this.random(32).toString('hex');
    }
    return this.secret;
  }
}

export function visitorKey(address: string, secret: string): { key: string; short: string } {
  const hex = createHmac('sha256', secret).update(address, 'utf8').digest('hex');
  return { key: hex, short: `ip:${hex.slice(0, 8)}` };
}
