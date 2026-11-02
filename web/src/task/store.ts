// The one trace store of the console (AIR-184) and the registry its rows read amounts through. A run's events go to this store only; the Task
// page and the fixture routes connect it to a run id. The registry is set once by the page after it reads `list_assets`.
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { createTraceStore } from './traceStore.ts';

let registryRef: AssetRegistry | null = null;

export function setRegistry(r: AssetRegistry | null): void {
  registryRef = r;
}

export const traceStore = createTraceStore({ registry: () => registryRef });
