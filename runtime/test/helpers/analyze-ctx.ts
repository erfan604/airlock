// AIR-180: the fixture context of the plan analyzer tests, plain data so AIR-185's console tests can reuse it. One registry with two assets,
// one book with three payees, the two contract limits. Values are written as bigint arithmetic, never through floats.
import type { AnalyzeCtx, AssetRegistry, BookView } from '../../src/analyze/index.ts';

export const NEAR_ID = 'near';
export const ETH_ID = 'evm:84532:native';
export const ACCOUNTANT = 'near:accountant.testnet';
export const LANDLORD = 'near:landlord.testnet';
export const CONTRACTOR = `evm:84532:0x${'ab'.repeat(20)}`;

export const YOCTO = 10n ** 24n;
export const WEI = 10n ** 18n;
export const near = (whole: bigint): bigint => whole * YOCTO;
export const U128_MAX = (1n << 128n) - 1n;

export function registry(): AssetRegistry {
  return new Map([
    [
      NEAR_ID,
      {
        symbol: 'NEAR',
        decimals: 24,
        hardCap: near(100n),
        dailyCap: near(1000n),
        quickTaskCap: near(50n),
        maxFeePerGas: 0n,
        maxGas: 0n,
        path: null,
      },
    ],
    [
      ETH_ID,
      {
        symbol: 'ETH.base',
        decimals: 18,
        hardCap: WEI / 10n,
        dailyCap: WEI,
        quickTaskCap: WEI / 20n,
        maxFeePerGas: 2_000_000_000n,
        maxGas: 100_000n,
        path: 'airlock-demo-1',
      },
    ],
  ]);
}

export function book(): BookView {
  return new Map([
    [ACCOUNTANT, { cap: near(5n), dailyUntrustedBudget: near(5n), dailyLimit: near(20n), label: 'accountant' }],
    [LANDLORD, { cap: null, dailyUntrustedBudget: 0n, dailyLimit: near(20n), label: 'landlord' }],
    [CONTRACTOR, { cap: WEI / 50n, dailyUntrustedBudget: WEI / 50n, dailyLimit: WEI / 10n, label: 'contractor' }],
  ]);
}

export function makeCtx(ownerText = '', over: Partial<AnalyzeCtx> = {}): AnalyzeCtx {
  return {
    ownerText,
    book: book(),
    registry: registry(),
    limits: { maxTaskActions: 20, maxTaskTtlMs: 3_600_000n },
    ...over,
  };
}
