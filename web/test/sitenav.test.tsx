// AIR-323 M2: the nav lists the two newest pages and marks the page you are on, and only that one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NAV, SiteNav } from '../src/shell/SiteNav.tsx';

const current = (path: string): string[] => [...renderToStaticMarkup(<SiteNav path={path} />).matchAll(/data-testid="tab-([a-z]+)"/g)].map((m) => m[1] ?? '').filter((id, i, all) => all.indexOf(id) === i && renderToStaticMarkup(<SiteNav path={path} />).includes(`aria-current="page" data-testid="tab-${id}"`));

test('nav: Approvals and Challenge are listed', () => {
  assert.ok(NAV.some((n) => n.path === 'approvals' && n.label === 'Approvals'));
  assert.ok(NAV.some((n) => n.path === 'challenge' && n.label === 'Challenge'));
});

test('nav: /approvals highlights Approvals only, /challenge highlights Challenge only, /replay and /task highlight Replay', () => {
  assert.deepEqual(current('/approvals'), ['approvals']);
  assert.deepEqual(current('/challenge'), ['challenge']);
  assert.deepEqual(current('/replay'), ['replay']);
  assert.deepEqual(current('/task'), ['replay']);
  assert.deepEqual(current('/'), ['overview']);
});
