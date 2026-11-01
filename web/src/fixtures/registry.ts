// Fixture routes: `/fixtures/<name>` renders a static, network-free state of the console, so every screenshot, e2e run and video
// take shows the same pixels. Each ticket registers its own fixtures; `expectAuditFail` marks the one route whose clip audit must
// fail (it proves the audit can fail).
import type { ReactElement } from 'react';

export type FixtureOpts = { expectAuditFail?: boolean };
export type Fixture = { name: string; render: () => ReactElement; expectAuditFail: boolean };

const fixtures = new Map<string, Fixture>();

export function registerFixture(name: string, render: () => ReactElement, opts: FixtureOpts = {}): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`fixture name must be lowercase letters, digits and dashes: ${name}`);
  if (fixtures.has(name)) throw new Error(`fixture already registered: ${name}`);
  fixtures.set(name, { name, render, expectAuditFail: opts.expectAuditFail === true });
}

/** In registration order. */
export function listFixtures(): Fixture[] {
  return [...fixtures.values()];
}

export function getFixture(name: string): Fixture | undefined {
  return fixtures.get(name);
}
