# Plumbing

How the pieces are wired when they are hosted somewhere other than `pnpm demo`. Each section says which file is the source of
truth, so a host can copy the rule and a reader can check it.

## Console CSP

The console is a static Vite build. Its security rests on one policy: scripts come from the console's own origin or carry a
per-response nonce, and nothing else runs. `web/csp.ts` builds the header (`buildCsp`), `web/vite-csp.ts` serves it with a fresh
nonce in `vite preview`, and `pnpm -C web e2e fixtures` fails when a document response carries any other policy or when the browser
reports a violation.

The header, one line in the response, shown here wrapped. Replace `<nonce>` per response, `<runtime-origin>` with the origin of the
runtime API (`http://localhost:8787` by default, `VITE_RUNTIME_ORIGIN` overrides it at build and preview time) and keep the other
lists as `web/csp.ts` has them:

```text
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-<nonce>';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://raw.githubusercontent.com;
  font-src 'self';
  connect-src 'self' <runtime-origin> https://test.rpc.fastnear.com https://near-testnet.drpc.org https://testnet-rpc.intea.rs https://rpc.testnet.near.org https://raw.githubusercontent.com https://cdn.jsdelivr.net https://wallet.intear.tech;
  frame-src 'self' https://raw.githubusercontent.com https://cdn.jsdelivr.net https://wallet.intear.tech;
  frame-ancestors 'none';
  base-uri 'none';
  object-src 'none';
  form-action 'self'
```

The nonce rule:

1. Draw a new nonce for every response that carries `index.html`: at least 16 random bytes, base64 encoded. Never reuse one, never
   derive it from the request.
2. Write the same value into the header and into every `nonce` attribute of the served HTML. The build leaves the placeholder
   `__AIRLOCK_CSP_NONCE__` in each of them (`html.cspNonce` in `web/vite.config.ts`); the host replaces every occurrence with the
   nonce of that response. A static header cannot do this, so a host needs a small piece of code or an edge function for it.
3. Send `Cache-Control: no-store` with the HTML, so a cached page never meets a header with another nonce.
4. `script-src` never contains `unsafe-inline`, `unsafe-eval` or `data:`. A host that cannot add a nonce must serve no inline script
   at all and may then use `script-src 'self'`.
5. Send the header on every response the host answers for the console, not only on the page you rewrite. `vite-csp.ts` sets it on
   every GET and HEAD that Vite does not proxy before it passes the request on, so a static file, the single page fallback and an
   error page carry it however the path is spelled (`/%69ndex.html`, `/./index.html`) and whatever `Accept` says. An HTML file
   served without the nonce rewrite keeps the placeholder, so its inline scripts stay blocked, which is the intended failure.
   Rewrite the page only for a request that reduces to a document path after decoding once, collapsing slashes and resolving dot
   segments, and answer a malformed escape with a bad request status.

What each list is for:

- Runtime origin and the four NEAR testnet RPC hosts (the order of `plan/STACK.md`, section RPC): the only places the console reads
  from besides itself. There is no Base RPC, because the console never talks to Base.
- Wallet origins: where the NEAR Connect manifest and the wallet executors load from. The list is a starting one; the wallet flow of
  AIR-182 confirms it and extends it in `web/csp.ts`.
- `style-src` allows inline styles because NEAR Connect 0.11.4 injects styles at runtime, and a policy without them breaks the
  wallet picker. Our own HTML and components use classes only. This is the one place the policy is looser than a bare `'self'`, and
  `docs/KNOWN_LIMITATIONS.md` says so.
- `img-src` allows `data:` for small inline images and lists the origins of wallet icons.

Same origin for the runtime: `vite preview` proxies `/session`, `/tasks`, `/runs` and `/api` to the runtime origin with
`changeOrigin` off, so the browser sees one origin, the session cookie is sent, `Host` and `Origin` are untouched and the event
stream arrives chunk by chunk. Any other host should do the same with a reverse proxy rule for those four path prefixes.
