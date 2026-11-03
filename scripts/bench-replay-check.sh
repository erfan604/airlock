#!/usr/bin/env bash
# AIR-228: re-derive every recorded bench run with no keys and no network, regenerate the table of docs/BENCH.md and fail when anything
# disagrees: the recordings (MANIFEST.sha256), the results file (REPLAY MISMATCH) or the committed table (before against after).
# BENCH_RECORDED and BENCH_RESULTS override the inputs (the tests point them at copies); the defaults are the committed files.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/env.sh
REC="${BENCH_RECORDED:-bench/runs/recorded}"
RES="${BENCH_RESULTS:-bench/results/final.json}"

if [ ! -s "$REC/MANIFEST.sha256" ] || ! (cd "$REC" && sha256sum -c MANIFEST.sha256 > /dev/null 2>&1); then
  echo "FAIL manifest ($REC/MANIFEST.sha256 is missing or a recording differs)"
  exit 1
fi
if [ ! -s "$RES" ]; then
  echo "FAIL results ($RES is missing or empty)"
  exit 1
fi
# the replay calls the release binary
(cd contracts/airlock-verdict && cargo build -q --release --offline --example verdict_cli)

mkdir -p target
cp docs/BENCH.md target/BENCH.before.md
out="target/bench-replay.out"
# the shim is loaded by absolute path: pnpm runs bench:replay with the working directory bench/, so a relative path would not resolve
if ! env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS="--require $PWD/scripts/no-network.cjs" \
  pnpm bench:replay --results "$RES" --recorded "$REC" > "$out" 2>&1; then
  head -30 "$out"
  cp target/BENCH.before.md docs/BENCH.md
  echo "FAIL replay (see the lines above)"
  exit 1
fi
n=$(sed -n 's/^REPLAY OK \([0-9][0-9]*\) runs$/\1/p' "$out" | tail -1)
if [ -z "$n" ]; then
  head -30 "$out"
  echo "FAIL replay (no REPLAY OK line)"
  exit 1
fi
# the baseline cases of AIR-306 have their own results file and recordings (final.json stays at 39 cases); same checks, no key, no network
EXTRA_REC="${BENCH_EXTRA_RECORDED:-bench/runs/recorded-baselines}"
EXTRA_RES="${BENCH_EXTRA_RESULTS:-bench/results/baselines-extra.json}"
if [ -s "$EXTRA_RES" ]; then
  if [ ! -s "$EXTRA_REC/MANIFEST.sha256" ] || ! (cd "$EXTRA_REC" && sha256sum -c MANIFEST.sha256 > /dev/null 2>&1); then
    echo "FAIL manifest ($EXTRA_REC/MANIFEST.sha256 is missing or a recording differs)"
    exit 1
  fi
  xout="target/bench-replay-extra.out"
  if ! env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS="--require $PWD/scripts/no-network.cjs" \
    pnpm bench:replay --no-doc --results "$EXTRA_RES" --recorded "$EXTRA_REC" > "$xout" 2>&1 || ! grep -q '^REPLAY OK [0-9][0-9]* runs$' "$xout"; then
    head -30 "$xout"
    cp target/BENCH.before.md docs/BENCH.md
    echo "FAIL replay of the baseline cases (see the lines above)"
    exit 1
  fi
  pnpm -C bench exec tsx src/scripts/structural-gaps.ts --results "../$EXTRA_RES" > /dev/null
fi
# the CrAIBench subset of AIR-229: its own results file, recordings and suite block of docs/BENCH.md; same checks, no key, no network
CB_REC="${BENCH_CB_RECORDED:-bench/runs/recorded-craibench}"
CB_RES="${BENCH_CB_RESULTS:-bench/results/craibench.json}"
if [ -s "$CB_RES" ]; then
  if [ ! -s "$CB_REC/MANIFEST.sha256" ] || ! (cd "$CB_REC" && sha256sum -c MANIFEST.sha256 > /dev/null 2>&1); then
    echo "FAIL manifest ($CB_REC/MANIFEST.sha256 is missing or a recording differs)"
    exit 1
  fi
  cout="target/bench-replay-craibench.out"
  if ! env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS="--require $PWD/scripts/no-network.cjs" \
    pnpm bench:replay --results "$CB_RES" --recorded "$CB_REC" --block craibench > "$cout" 2>&1 || ! grep -q '^REPLAY OK [0-9][0-9]* runs$' "$cout"; then
    head -30 "$cout"
    cp target/BENCH.before.md docs/BENCH.md
    echo "FAIL replay of the CrAIBench subset (see the lines above)"
    exit 1
  fi
fi
if ! cmp -s docs/BENCH.md target/BENCH.before.md; then
  diff target/BENCH.before.md docs/BENCH.md | head -20 || true
  cp target/BENCH.before.md docs/BENCH.md
  echo "FAIL BENCH.md differs from the regenerated block"
  exit 1
fi
echo "BENCH REPLAY OK $n runs, block unchanged"
