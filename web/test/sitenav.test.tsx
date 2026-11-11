// AIR-323 M2: the nav lists the two newest pages and marks the page you are on, and only that one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MORE, MoreNav, NAV, PRIMARY, SiteNav, edgesOf } from '../src/shell/SiteNav.tsx';

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

// visitor test 2026-11-11: at 390 px the strip was cut at "Terms" and More sat off screen. A phone keeps one 44 px row (the card pages'
// AIR-181 geometry) with Lend, Rob it, Break and More; every other page is in the More menu, and More carries the current-page mark then.
test('nav: a phone row holds Lend, Rob it, Break and More, and More marks a current page it holds', () => {
  const html = renderToStaticMarkup(<SiteNav path="/lend" />);
  assert.ok(html.includes('data-edge=""'));
  assert.equal((html.match(/class="site-wide"/g) ?? []).length, 2, 'Terms and Credit wait in More on a phone');
  assert.ok(html.includes('<span class="site-tab-long">Break the proof</span><span class="site-tab-short">Break</span>'));
  assert.ok(!/data-testid="nav-more" data-current/.test(html));
  const bench = renderToStaticMarkup(<SiteNav path="/bench" />);
  assert.equal((bench.match(/class="site-wide"/g) ?? []).length, 3, 'the current page of the second group is in the menu on a phone');
  assert.ok(/data-testid="nav-more" data-current="true"/.test(bench));
  assert.ok(/data-testid="nav-more" data-current="true"/.test(renderToStaticMarkup(<SiteNav path="/terms" />)));
});

test('nav: More opens a menu in place that lists every other page, Terms and Credit included for a phone', () => {
  const html = renderToStaticMarkup(<SiteNav path="/bench" />);
  assert.ok(/<details class="site-menu"/.test(html));
  assert.ok(!html.includes('href="#more"'), 'More no longer jumps to the footer');
  for (const n of [...MORE, ...PRIMARY.filter((p) => p.path === 'terms' || p.path === 'credit')]) assert.ok(html.includes(`data-testid="menu-${n.path}"`), n.path);
  assert.ok(/aria-current="page" data-testid="menu-bench"/.test(html));
});

// A blind read called 13 tabs "too many things": the header holds the six a stranger should touch, the rest sit in one quieter group that every
// page renders above its footer, so every page is one click from every page and the current one is always marked.
test('nav: six primary tabs in order, the rest in the second group, each page exactly once', () => {
  assert.deepEqual(PRIMARY.map((n) => n.label), ['Overview', 'Lend', 'Rob it', 'Break the proof', 'Terms', 'Credit']);
  assert.deepEqual(MORE.map((n) => n.label), ['Try it', 'Use it', 'Replay', 'Approvals', 'Challenge', 'Bench', 'Proven']);
  const all = [...PRIMARY, ...MORE].map((n) => n.path);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...all].sort(), NAV.map((n) => n.path).sort());
});

test('nav: a page of the second group is marked in the header too, beside the link to the second group', () => {
  const tabs = (path: string): string[] => [...renderToStaticMarkup(<SiteNav path={path} />).matchAll(/data-testid="tab-([a-z]+)"/g)].map((m) => m[1] ?? '');
  assert.deepEqual(tabs('/lend'), ['overview', 'lend', 'rob', 'break', 'terms', 'credit']);
  assert.deepEqual(tabs('/bench'), ['overview', 'lend', 'rob', 'break', 'terms', 'credit', 'bench']);
  assert.deepEqual(current('/bench'), ['bench']);
  assert.ok(renderToStaticMarkup(<SiteNav path="/lend" />).includes('data-testid="nav-more"'), 'the header opens the second group');
});

test('nav: the second group lists every other page as a plain link and marks the current one', () => {
  const html = renderToStaticMarkup(<MoreNav path="/replay" />);
  for (const n of MORE) assert.ok(html.includes(`data-testid="more-${n.path}"`), n.path);
  assert.ok(html.includes('id="more"'));
  assert.ok(/aria-current="page" data-testid="more-replay"/.test(html));
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.ok(renderToStaticMarkup(<MoreNav path="/task" />).includes('aria-current="page" data-testid="more-replay"'));
  assert.equal((renderToStaticMarkup(<MoreNav path="/lend" />).match(/aria-current/g) ?? []).length, 0);
});
