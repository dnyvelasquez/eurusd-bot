import fs from 'fs';
import path from 'path';

import { runBacktest, toETString } from './backtest-runner';
import type { BacktestReport, BacktestTrade } from './backtest.types';

// ── CLI arg parser ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith('--') && argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      out[argv[i]!.slice(2)] = argv[i + 1]!;
      i++;
    } else if (argv[i] && !argv[i]!.startsWith('--')) {
      positional.push(argv[i]!);
    }
  }
  // npm@10+ strips --start/--end as unknown config flags but passes values as positionals
  if (!out['start'] && !out['from'] && positional[0]) out['start'] = positional[0]!;
  if (!out['end']   && !out['to']   && positional[1]) out['end']   = positional[1]!;
  return out;
}

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');
const DEFAULT_BLOCKED_HOURS = [
  { from: '09:30', to: '09:35', label: 'NY Open' },
  { from: '12:00', to: '12:30', label: 'NY Lunch' },
  { from: '15:45', to: '16:00', label: 'NY Close' },
  { from: '16:00', to: '09:30', label: 'Out of market' },
];

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Console report ────────────────────────────────────────────────────────────

const SEP = '═'.repeat(80);
const sep = '─'.repeat(80);

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function tradeRow(t: BacktestTrade): string {
  const icon = t.result === 'WIN' ? '✓' : t.result === 'LOSS' ? '✗' : '○';
  const pnl = (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2);
  const rr = t.actualRr !== null ? t.actualRr.toFixed(2) : 'n/a';
  return [
    pad(t.tradeNumber, 3, true),
    pad(t.openTimeISO, 17),
    pad(t.side, 5),
    pad(t.entry.toFixed(2), 9, true),
    pad(t.sl.toFixed(2), 9, true),
    pad(t.tp.toFixed(2), 9, true),
    pad(rr, 6, true),
    `${icon} ${pad(t.result, 5)}`,
    pad(pnl, 10, true),
  ].join('  ');
}

function printReport(r: BacktestReport): void {
  const m = r.metrics;
  const pnlSign = r.metrics.totalPnl >= 0 ? '+' : '';

  console.log('\n' + SEP);
  console.log(` SPX500 Bot — Backtest │ ${r.symbol}  ${r.from} → ${r.to}`);
  console.log(` Balance: $${r.initialBalance.toFixed(2)} → $${r.finalBalance.toFixed(2)}  │  Risk: ${r.riskPercent}%  │  Cooldown: ${r.cooldownMinutes} min`);
  console.log(SEP);

  if (r.trades.length === 0) {
    console.log('\n  No trades in the selected period.\n');
  } else {
    console.log();
    console.log([
      pad('#', 3, true),
      pad('Apertura (ET)', 17),
      pad('Dir', 5),
      pad('Entry', 9, true),
      pad('SL', 9, true),
      pad('TP', 9, true),
      pad('R:R', 6, true),
      pad('Resultado', 8),
      pad('P&L ($)', 10, true),
    ].join('  '));
    console.log(sep);
    for (const t of r.trades) console.log(tradeRow(t));
    console.log();
  }

  console.log(SEP);
  console.log(' RESULTADOS');
  console.log(SEP);
  console.log(` Total trades:          ${m.totalTrades}`);
  console.log(` Wins / Losses / Open:  ${m.wins} / ${m.losses} / ${m.openTrades}`);
  console.log(` Win rate:              ${m.winRate.toFixed(1)}%`);
  console.log(` Profit factor:         ${m.profitFactor === 999 ? '∞' : m.profitFactor.toFixed(2)}`);
  console.log(` Avg R:R (completadas): ${m.avgRr.toFixed(2)}`);
  console.log(` Avg R:R (wins):        ${m.avgWinRr.toFixed(2)}`);
  console.log(` Avg R:R (losses):      ${m.avgLossRr.toFixed(2)}`);
  console.log(` Total P&L:             ${pnlSign}$${m.totalPnl.toFixed(2)}`);
  console.log(` Max drawdown:          ${m.maxDrawdownPct.toFixed(2)}%`);
  console.log(` Max racha de pérdidas: ${m.maxConsecutiveLosses}`);
  console.log(SEP + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readConfig();

  const symbol   = args['symbol']   ?? (cfg['SYMBOL'] as string | undefined)   ?? 'SPX500';
  const from     = args['start']    ?? args['from'];
  const to       = args['end']      ?? args['to'];
  const balance  = parseFloat(args['balance'] ?? '10000');
  const risk     = parseFloat(args['risk']    ?? String(cfg['RISK_PERCENT']   ?? 1));
  const cooldown = parseInt(args['cooldown']  ?? String(cfg['SIGNAL_COOLDOWN_MINUTES'] ?? 30), 10);

  if (!from || !to) {
    console.error('\nUso: npm run backtest -- --start YYYY-MM-DD --end YYYY-MM-DD [--symbol SPX500] [--balance 10000] [--risk 1] [--cooldown 30]\n');
    process.exit(1);
  }

  const report = await runBacktest({
    symbol,
    from,
    to,
    initialBalance: balance,
    riskPercent: risk,
    cooldownMinutes: cooldown,
    blockedHours: (cfg['BLOCKED_HOURS'] as typeof DEFAULT_BLOCKED_HOURS | undefined) ?? DEFAULT_BLOCKED_HOURS,
    minFvgPoints: (cfg['MIN_FVG_POINTS'] as number | undefined) ?? 0,
    minSlPoints: (cfg['MIN_SL_POINTS'] as number | undefined) ?? 0,
    m15ConfirmationEnabled: (cfg['M15_CONFIRMATION_ENABLED'] as boolean | undefined) ?? false,
  });

  printReport(report);

  const outFile = path.resolve(process.cwd(), `backtest-${symbol}-${from}-${to}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Reporte guardado en: ${outFile}\n`);
}

main().catch((err: unknown) => {
  console.error('Backtest falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
