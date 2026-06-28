import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { runBacktest } from './backtest-runner';
import { resolveBacktestParams } from './index';

// Regression guard for the broker-offset non-determinism bug class found in spx500-bot
// (see docs/backtest-determinism-fix.md there): if the backtest measures the broker's
// server clock live on every run instead of using a fixed constant, the same
// symbol/period/params can yield different trade sets across runs. Running the backtest
// twice in the SAME process must produce an identical trade set. Fails loudly (non-zero
// exit) if it doesn't.
//
// Uses resolveBacktestParams() from index.ts — the exact same config/CLI resolution as
// `npm run backtest` — so this check never drifts from what the real CLI command would
// actually run.
//
// Same-process double-run (the default mode below) does NOT catch the FASE 2B-bis bug
// class: fetchBrokerOffsetSeconds() caches its result per-process (offsetCache), so two
// runBacktest() calls in the same Node process always reuse the first measurement — the
// ±60s rounding jitter only appears across SEPARATE process invocations whose wall-clock
// "now" can land on opposite sides of a minute boundary. `--cross-process` below spawns
// two real child processes with a >60s pause between them to reproduce that exact
// condition; pass `--frozen-dir <dir>` to exercise the frozen-offset fix (FASE 2B-bis).

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tradeKey(t: { openTime: number; signalType: string; side: string; result: string; pnl: number }): string {
  return `${t.openTime}|${t.signalType}|${t.side}|${t.result}|${t.pnl}`;
}

interface CliFlags {
  start: string;
  end: string;
  frozenDir?: string;
  crossProcess: boolean;
  singleRun: boolean;
}

function parseCliArgs(argv: string[]): CliFlags {
  const positional: string[] = [];
  let frozenDir: string | undefined;
  let crossProcess = false;
  let singleRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--frozen-dir') { frozenDir = argv[++i]; }
    else if (argv[i] === '--cross-process') { crossProcess = true; }
    else if (argv[i] === '--single-run') { singleRun = true; }
    else { positional.push(argv[i]!); }
  }
  return {
    start: positional[0] ?? '2025-02-01',
    end: positional[1] ?? '2025-12-31',
    frozenDir,
    crossProcess,
    singleRun,
  };
}

async function runOnce(flags: CliFlags): Promise<{ keys: string[]; metrics: unknown }> {
  const cfg = readConfig();
  const params = resolveBacktestParams({ start: flags.start, end: flags.end, 'frozen-dir': flags.frozenDir ?? '' }, cfg);
  const report = await runBacktest(params);
  return { keys: report.trades.map(tradeKey), metrics: report.metrics };
}

// `--single-run` mode: used internally by `--cross-process` to spawn a fresh child
// process per run. Prints {keys, metrics} as JSON on stdout and nothing else, so the
// parent can capture+parse it cleanly.
const SINGLE_RUN_MARKER = '###SINGLE_RUN_RESULT###';

async function singleRunMode(flags: CliFlags): Promise<void> {
  const result = await runOnce(flags);
  // runBacktest() logs progress (candle counts, etc.) to stdout via console.log — prefix
  // our machine-readable result with a marker so the parent process can pull it out of the
  // mixed output instead of needing runBacktest() to go silent.
  process.stdout.write(`${SINGLE_RUN_MARKER}${JSON.stringify(result)}`);
}

// `--cross-process` mode: spawns two SEPARATE `tsx` child processes (own offsetCache each,
// own wall-clock "now" each) with a >60s sleep between them — the exact condition that
// triggered the FASE 2B-bis bug (offset rounding landing on opposite sides of a minute
// boundary between two non-simultaneous runs). Pass --frozen-dir to verify the fix; without
// it, this exercises the live bridge path (still expected to be non-deterministic — that's
// the live bridge's pre-existing behavior, untouched by this fix on purpose).
async function crossProcessMode(flags: CliFlags): Promise<void> {
  const scriptPath = __filename;
  const baseArgs = [scriptPath, flags.start, flags.end, '--single-run'];
  if (flags.frozenDir) baseArgs.push('--frozen-dir', flags.frozenDir);

  console.log(`Cross-process check: symbol/period via resolveBacktestParams, frozenDir=${flags.frozenDir ?? '(none — live bridge)'}`);

  const extractResult = (out: string): { keys: string[]; metrics: unknown } => {
    const idx = out.indexOf(SINGLE_RUN_MARKER);
    if (idx === -1) throw new Error(`Child process output missing ${SINGLE_RUN_MARKER}:\n${out}`);
    return JSON.parse(out.slice(idx + SINGLE_RUN_MARKER.length)) as { keys: string[]; metrics: unknown };
  };

  console.log('\nRun A (child process)...');
  const outA = execFileSync('npx', ['tsx', ...baseArgs], { encoding: 'utf-8', shell: true });
  const resultA = extractResult(outA);
  console.log(`  ${resultA.keys.length} trades`);

  const pauseMs = 65_000;
  console.log(`\nWaiting ${pauseMs / 1000}s (deliberately crossing a minute boundary, to reproduce the bug condition)...`);
  await new Promise(resolve => setTimeout(resolve, pauseMs));

  console.log('\nRun B (separate child process, >60s later)...');
  const outB = execFileSync('npx', ['tsx', ...baseArgs], { encoding: 'utf-8', shell: true });
  const resultB = extractResult(outB);
  console.log(`  ${resultB.keys.length} trades`);

  reportResult(resultA, resultB, 'cross-process');
}

function reportResult(
  a: { keys: string[]; metrics: unknown },
  b: { keys: string[]; metrics: unknown },
  label: string,
): void {
  const sameSet = JSON.stringify(a.keys) === JSON.stringify(b.keys);
  const sameMetrics = JSON.stringify(a.metrics) === JSON.stringify(b.metrics);

  if (!sameSet || !sameMetrics) {
    console.error(`\n❌ DETERMINISM CHECK FAILED (${label})`);
    console.error(`  Run A: ${a.keys.length} trades`);
    console.error(`  Run B: ${b.keys.length} trades`);
    if (!sameSet) {
      console.error('  Trade sets differ:');
      console.error('  A:', a.keys);
      console.error('  B:', b.keys);
    }
    if (!sameMetrics) {
      console.error('  Metrics differ:');
      console.error('  A:', a.metrics);
      console.error('  B:', b.metrics);
    }
    process.exit(1);
  }

  console.log(`\n✅ DETERMINISM CHECK PASSED (${label}) — ${a.keys.length} trades, identical set and metrics across both runs.`);
}

async function main(): Promise<void> {
  const flags = parseCliArgs(process.argv.slice(2));

  if (flags.singleRun) {
    await singleRunMode(flags);
    return;
  }

  if (flags.crossProcess) {
    await crossProcessMode(flags);
    return;
  }

  // Default: same-process double run (does NOT catch the offset-jitter bug — see header).
  const cfg = readConfig();
  const params = resolveBacktestParams({ start: flags.start, end: flags.end, ...(flags.frozenDir ? { 'frozen-dir': flags.frozenDir } : {}) }, cfg);
  console.log(`Params: symbol=${params.symbol} from=${params.from} to=${params.to}`);

  console.log('Run A...');
  const reportA = await runBacktest(params);
  console.log(`  ${reportA.trades.length} trades`);

  console.log('Run B (same process)...');
  const reportB = await runBacktest(params);
  console.log(`  ${reportB.trades.length} trades`);

  reportResult(
    { keys: reportA.trades.map(tradeKey), metrics: reportA.metrics },
    { keys: reportB.trades.map(tradeKey), metrics: reportB.metrics },
    'same-process',
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
