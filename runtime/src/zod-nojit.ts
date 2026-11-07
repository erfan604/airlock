// AIR-323: zod probes `new Function("")` to see whether it may compile its parsers; under a CSP without `unsafe-eval` that probe is reported as a
// `securitypolicyviolation` on every page of the console. The console imports this module first (web/src/main.tsx), before any module that builds
// a schema, so the interpreted parsers are used and no Function is constructed. The runtime server never imports it and keeps zod's default.
import { z } from 'zod';

/** True once zod is configured. The call is the initializer of this export on purpose: the build treats runtime/src as free of side effects, so a bare `z.config(...)` statement would be dropped. Imported and read by web/src/main.tsx. */
export const ZOD_JITLESS: boolean = z.config({ jitless: true }).jitless === true;
