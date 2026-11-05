// AIR-310: the static build. `vite build --mode static` makes web/dist-static/, which runs from plain files on any static host: the replay data the
// replay server answers is written to JSON files at build time (scripts/export-static.ts) and read by the same parse code through the adapter
// in replay/staticApi.ts. Nothing here is read by the live build, whose `MODE` is `production`.
type Meta = { env?: { MODE?: string; BASE_URL?: string } };
const env = (import.meta as unknown as Meta).env;
/** AIR-311: the build-time prerender (scripts/prerender.tsx) runs the app under Node, where Vite's constants do not exist; it sets this first. */
// Only read when Vite did not set a mode (Node), so a Vite build still folds STATIC to a constant.
const prerender = env?.MODE === undefined ? (globalThis as { __AIRLOCK_PRERENDER__?: { base: string } }).__AIRLOCK_PRERENDER__ : undefined;

/** True only in the static build. Vite replaces `import.meta.env.MODE` by a constant, so a live build keeps none of the static paths alive. */
export const STATIC: boolean = env?.MODE === 'static' || prerender !== undefined;

/** True while the static build renders a page to HTML at build time (no window, no fetch). */
export const PRERENDER: boolean = prerender !== undefined;

/** The base path the build was made for: `/` by default, `/<repo>/` for a GitHub Pages project site (`STATIC_BASE=/<repo>/ pnpm build:static`). */
export const BASE: string = (prerender?.base ?? env?.BASE_URL ?? '/').replace(/\/?$/, '/');

/** A URL under the base: `url('data/acts.json')` is `/data/acts.json` or `/<repo>/data/acts.json`. */
export const url = (path: string): string => `${BASE}${path.replace(/^\//, '')}`;

/** The route path of a location pathname with the base taken off, so `/<repo>/proven` routes as `/proven`. */
export function routePath(pathname: string): string {
  if (BASE !== '/' && pathname.startsWith(BASE)) return `/${pathname.slice(BASE.length)}`;
  if (BASE !== '/' && `${pathname}/` === BASE) return '/';
  return pathname;
}
