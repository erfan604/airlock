// Type tests (AIR-183): compiles only because every error below is expected. If one stops being an error, `tsc` fails with
// "Unused '@ts-expect-error' directive". This file is never executed.
import type { LabelName } from '@airlock/runtime/dsl';
import { createElement } from 'react';
import { SEAL_SPECS, Seal } from '../src/components/Seal.tsx';
import type { SealSpec } from '../src/components/Seal.tsx';
import { Specimen } from '../src/components/Specimen.tsx';
import { Untrusted } from '../src/components/untrusted.ts';

declare const untrusted: Untrusted;
declare const plain: string;

// an unknown label for Seal
// @ts-expect-error not a LabelName
createElement(Seal, { label: 'Untrusted:newchannel' });

// the seal table is exhaustive: a table with one more key cannot be built from it
// @ts-expect-error the extra key has no spec
export const widened: Record<LabelName | 'Untrusted:newchannel', SealSpec> = SEAL_SPECS;

// an Untrusted is not a string
// @ts-expect-error Untrusted is opaque
export const asString: string = untrusted;

// a string is not an Untrusted
// @ts-expect-error only wrapUntrusted makes one
export const asUntrusted: Untrusted = plain;

// the Specimen takes an Untrusted, never a string
// @ts-expect-error text must be an Untrusted
createElement(Specimen, { text: 'raw', channel: 'email' });
