// AIR-310: the static build. `vite build --mode static` makes web/dist-static/, which runs from plain files on any static host: the replay data the
// replay server answers is written to JSON files at build time (scripts/export-static.ts) and read by the same parse code through the adapter
// in replay/staticApi.ts. Nothing here is read by the live build, whose `MODE` is `production`.
type Meta = { env?: { MODE?: string; BASE_URL?: string } };
const env = (import.meta as unknown as Meta).env;

/** True only in the static build. Vite replaces `import.meta.env.MODE` by a constant, so a live build keeps none of the static paths alive. */
export const STATIC: boolean = env?.MODE === 'static';

/** The base path the build was made for: `/` by default, `/<repo>/` for a GitHub Pages project site (`STATIC_BASE=/<repo>/ pnpm build:static`). */
export const BASE: string = (env?.BASE_URL ?? '/').replace(/\/?$/, '/');

/** A URL under the base: `url('data/acts.json')` is `/data/acts.json` or `/<repo>/data/acts.json`. */
export const url = (path: string): string => `${BASE}${path.replace(/^\//, '')}`;

/** The route path of a location pathname with the base taken off, so `/<repo>/proven` routes as `/proven`. */
export function routePath(pathname: string): string {
  if (BASE !== '/' && pathname.startsWith(BASE)) return `/${pathname.slice(BASE.length)}`;
  if (BASE !== '/' && `${pathname}/` === BASE) return '/';
  return pathname;
}
