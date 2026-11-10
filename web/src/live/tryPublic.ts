// AIR-356: the public file of the "try it live" card, as the page reads it. The format and its strict parser live in the runtime
// (runtime/src/trycard/public.ts), next to the script that writes the file, so the two cannot drift.
export { TRY_PUBLIC_FORMAT, parseTryPublic, refusedTryAccount } from '@airlock/runtime/try-public';
export type { TryProof, TryPublic, TryTask } from '@airlock/runtime/try-public';
