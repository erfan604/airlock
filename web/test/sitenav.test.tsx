// AIR-323 M2: the nav lists the two newest pages and marks the page you are on, and only that one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NAV, SiteNav, edgesOf } from '../src/shell/SiteNav.tsx';

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

// AIR-346 (D20): the phone strip fades the edge that has more tabs past it, on either side, and none when everything fits.
test('nav: edgesOf names the edges with tabs beyond them', () => {
  assert.equal(edgesOf({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), '');
  assert.equal(edgesOf({ scrollLeft: 0, clientWidth: 300, scrollWidth: 600 }), 'end');
  assert.equal(edgesOf({ scrollLeft: 120, clientWidth: 300, scrollWidth: 600 }), 'start end');
  assert.equal(edgesOf({ scrollLeft: 300, clientWidth: 300, scrollWidth: 600 }), 'start');
  assert.equal(edgesOf({ scrollLeft: 299.5, clientWidth: 300, scrollWidth: 600 }), 'start', 'a sub-pixel remainder is the end');
});

test('nav: the strip carries a fade attribute before any script runs, so a long strip still fades its right edge', () => {
  assert.ok(renderToStaticMarkup(<SiteNav path="/credit" />).includes('data-edge="end"'));
});
