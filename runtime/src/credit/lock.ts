// AIR-359: the lock file shared by the jobs that sign as the credit card's agent (the arena round and the economy loop), so two of them
// never send at once and collide on the agent's nonce. A file made with an exclusive create, holding the holder's pid and time. A lock
// whose holder is gone, or that is older than `staleMs`, is taken over. Not a kernel lock: it only has to keep two cron jobs apart.
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A lock older than this is stale: no job holds it this long (a round and a cycle each take a few minutes at most). */
export const LOCK_STALE_MS = 30 * 60_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Takes the lock and answers the function that releases it, or null when another job holds it. */
export function takeLock(path: string, nowMs: number, opts: { staleMs?: number; alive?: (pid: number) => boolean } = {}): (() => void) | null {
  const alive = opts.alive ?? pidAlive;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, atMs: nowMs }));
      closeSync(fd);
      return () => {
        try {
          const held = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
          if (held.pid === process.pid) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder: { pid: number; atMs: number } | null = null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; atMs?: unknown };
      if (typeof raw.pid === 'number' && typeof raw.atMs === 'number') holder = { pid: raw.pid, atMs: raw.atMs };
    } catch {
      holder = null;
    }
    // an unreadable lock is someone's half-written file: leave it
    if (holder === null) return null;
    if (nowMs - holder.atMs < staleMs && alive(holder.pid)) return null;
    try {
      unlinkSync(path);
    } catch {
      return null;
    }
  }
  return null;
}
