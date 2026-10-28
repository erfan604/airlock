// The default policy on the arguments of a tool call: data from an untrusted source never names what a tool fetches or reads
// (SPEC 6 rule 10). An argument that is Unresolved or carries any Untrusted channel is refused, and the run aborts RefusedToolArg.
import type { ToolArgPolicy } from './types.ts';

export const defaultToolArgPolicy: ToolArgPolicy = (_tool, args) => {
  for (const value of Object.values(args)) {
    for (const label of value.labels) {
      if (label === 'Unresolved' || label.startsWith('Untrusted:')) return { allow: false, code: 'UntrustedToolArg' };
    }
  }
  return { allow: true };
};
