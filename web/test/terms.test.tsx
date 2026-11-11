// AIR-362: the /terms page. It renders docs/terms.json (the same source as docs/TERMS.md and scripts/terms-check.ts), every citation of it
// still holds at this commit, and the text a reader sees passes the banned phrase list, never says testnet, and says "test network" in its
// one network clause alone. The page is a lazy route of the static site with a print stylesheet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { BANNED_WORDS, checkTerms, clauses, loadTerms, refText } from '../../scripts/terms-lib.ts';
import { TermsPage } from '../src/terms/TermsPage.tsx';
import { ROUTES } from '../src/routes.ts';
import { PAGES } from '../src/pages.ts';
import { STATIC_ROUTES } from '../vite-static.ts';

const web = fileURLToPath(new URL('../', import.meta.url));
const terms = loadTerms();

function text(html: string): string {
  return html
    .replace(/<wbr\/?>/g, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

test('every citation of docs/terms.json holds at this commit', () => {
  assert.deepEqual(checkTerms(terms), []);
});

test('the page shows every clause, its status and every reference', () => {
  const t = text(renderToStaticMarkup(<TermsPage />));
  assert.ok(t.includes(terms.title) && t.includes(terms.claim));
  for (const c of clauses(terms)) {
    assert.ok(t.includes(c.n) && t.includes(c.text), `clause ${c.n}`);
    assert.ok(t.includes(c.status), `status of ${c.n}`);
    for (const r of c.refs) {
      const name = 'what' in r ? r.what : (r.name ?? r.file);
      assert.ok(t.includes(name), `${c.n}: ${refText(r)}`);
    }
  }
  assert.ok(t.includes('Schedule of cited files'));
});

test('the page text passes the banned phrases, never says testnet and says test network once', () => {
  const t = text(renderToStaticMarkup(<TermsPage />));
  const list = readFileSync(join(web, '..', 'docs', 'banned-phrases.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('README-only:'));
  for (const p of list) assert.ok(!new RegExp(p, 'i').test(t), p);
  for (const w of BANNED_WORDS) assert.ok(!new RegExp(`(^|[^a-z_])${w}([^a-z_]|$)`, 'i').test(t), w);
  assert.ok(!/testnet/i.test(t), 'testnet');
  assert.ok(!/erfan/i.test(t), 'a personal name');
  assert.equal(t.match(/test network/gi)?.length ?? 0, 1);
  assert.ok(!t.includes('--') && !t.includes(String.fromCharCode(0x2014)) && !t.includes(String.fromCharCode(0x2013)));
});

test('/terms is a lazy route of the static site, prerendered, with a print stylesheet', () => {
  assert.equal(typeof ROUTES['/terms'], 'function');
  assert.ok(/lazy\(\(\) => import\('\.\/terms\/TermsPage\.tsx'\)\)/.test(readFileSync(join(web, 'src', 'routes.ts'), 'utf8')));
  assert.ok(PAGES.some((p) => p.path === '/terms' && p.alias === undefined));
  assert.ok((STATIC_ROUTES as readonly string[]).includes('terms'));
  assert.ok(readFileSync(join(web, 'src', 'styles', 'terms.css'), 'utf8').includes('@media print'));
});

// visitor test 2026-11-11: the page was monospace throughout and read like a code dump. The clauses are set in the reading face; code
// references, paths and hashes keep the data face.
test('terms: clause sentences use the reading face and code references the data face', () => {
  const css = readFileSync(new URL('../src/styles/terms.css', import.meta.url), 'utf8');
  const rule = (sel: string): string => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('.terms-doc '), /font-family: var\(--font-system\)/);
  assert.match(rule('.terms .terms-doc dt '), /font-family: var\(--font-system\)/);
  assert.match(rule('.terms-id,'), /font-family: var\(--font-data\)/);
  assert.ok(!/font-family: var\(--font-evidence\)/.test(css.split('@media print')[0] ?? ''), 'no typewriter face on screen');
});
