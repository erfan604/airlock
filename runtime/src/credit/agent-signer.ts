// AIR-359: the signer of a job that signs as the credit card's agent, loaded by the arena's rule (runtime/src/arena/signer.ts): the scoped
// function-call key (the card only, submit_batch and expire) when the agent account lists it and its file holds it; the agent's full-access
// key only with ARENA_ALLOW_AGENT_KEY=1. Keys are loaded through signerFromCredentials and never read or printed here.
import { existsSync } from 'node:fs';
import { ARENA_SCOPED_PUBLIC_KEY } from '../arena/facts.ts';
import { KEYCHAIN_FLAG, planArenaSigner, signerLine } from '../arena/signer.ts';
import { signerFromCredentials } from '../chain/signer.ts';

export type AgentSigner = ReturnType<typeof signerFromCredentials>;

export async function loadAgentSigner(p: {
  agent: string;
  /** the public keys of the agent account (view_access_key_list) */
  keys: readonly string[];
  scopedFile: string;
  keychainFile: string | null;
  env: Record<string, string | undefined>;
}): Promise<{ signer: AgentSigner; publicKey: string; line: string } | { refuse: string }> {
  const short = (e: unknown): string => (e instanceof Error ? e.message.slice(0, 160) : 'unknown error');
  let loaded: AgentSigner | null = null;
  let scopedUnfit: string | null = null;
  if (p.keys.includes(ARENA_SCOPED_PUBLIC_KEY)) {
    if (!existsSync(p.scopedFile)) scopedUnfit = 'the scoped arena key is on the agent account but its key file is missing (ARENA_KEY_FILE)';
    else {
      try {
        loaded = signerFromCredentials(p.scopedFile, p.agent);
        if ((await loaded.getPublicKey()).toString() !== ARENA_SCOPED_PUBLIC_KEY) scopedUnfit = 'the arena key file does not hold the scoped arena key (ARENA_KEY_FILE)';
      } catch (e) {
        scopedUnfit = `the arena key file cannot be used (${short(e)})`;
      }
    }
  }
  const plan = planArenaSigner({ keys: p.keys, scopedFile: scopedUnfit, allowKeychain: p.env[KEYCHAIN_FLAG] === '1' });
  if ('refuse' in plan) return { refuse: plan.refuse };
  if (plan.kind === 'keychain') {
    if (p.keychainFile === null || !existsSync(p.keychainFile)) return { refuse: `${plan.why}, and the agent's keychain credentials file is missing (ARENA_AGENT_CREDENTIALS)` };
    try {
      loaded = signerFromCredentials(p.keychainFile, p.agent);
    } catch (e) {
      return { refuse: `the keychain signer cannot be loaded: ${short(e)}` };
    }
  }
  if (loaded === null) return { refuse: 'no signer was loaded' };
  const publicKey = (await loaded.getPublicKey()).toString();
  if (!p.keys.includes(publicKey)) return { refuse: `the ${plan.kind} signer's key ${publicKey} is not on the agent account` };
  return { signer: loaded, publicKey, line: signerLine(plan.kind, publicKey, plan.kind === 'keychain' ? plan.why : undefined) };
}
