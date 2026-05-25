import axios from 'axios';

import { StrategyEngine } from '@bot-core/core/strategy-engine';
import { BiasEngine } from '@bot-core/strategy/bias/bias-engine';
import { detectEqualHighs, detectEqualLows } from '@bot-core/strategy/liquidity/equal-levels';
import { FVGDetector } from '@bot-core/strategy/fvg/fvg-detector';
import { DisplacementDetector } from '@bot-core/strategy/fvg/displacement-detector';
import { EntryValidator } from '@bot-core/strategy/entry/entry-validator';
import { PositionSizing } from '@bot-core/strategy/risk/position-sizing';

import type { LiquiditySweep } from '@bot-core/strategy/liquidity/liquidity.types';
import type { MSS } from '@bot-core/strategy/mss/mss-types';
import type { Candle } from '@bot-core/services/mt5/mt5.types';

import type { BacktestTrade, BacktestReport, BacktestMetrics, TradeResult } from './backtest.types';

const BRIDGE_URL = 'http://127.0.0.1:8000/api/trading';
const WARM_UP_DAYS = 5;
const WARM_UP_CANDLES = 100;
const MAX_LOOKAHEAD = 500;
const MAX_VOLUME = 20.0;
const MIN_VOLUME = 0.1;
const SL_BUFFER_RATIO = 0.1;

export interface BlockedWindow {
  from: string;
  to: string;
  label: string;
}

export interface BacktestParams {
  symbol: string;
  from: string;
  to: string;
  initialBalance: number;
  riskPercent: number;
  cooldownMinutes: number;
  blockedHours: BlockedWindow[];
  minFvgPoints: number;
  minSlPoints: number;
  m15ConfirmationEnabled: boolean;
}

// ── Bridge fetch ──────────────────────────────────────────────────────────────

async function fetchCandles(symbol: string, tf: string, from: string, to: string): Promise<Candle[]> {
  const url = `${BRIDGE_URL}/candles/${symbol}/${tf}/range`;
  const resp = await axios.get<{ success: boolean; data: Candle[]; message?: string }>(url, {
    params: { from_date: from, to_date: to },
    timeout: 120_000,
  });
  if (!resp.data.success || !resp.data.data) {
    throw new Error(`Failed to fetch ${tf} candles: ${resp.data.message ?? 'unknown error'}`);
  }
  return resp.data.data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isInWindow(current: string, from: string, to: string): boolean {
  if (from <= to) return current >= from && current < to;
  return current >= from || current < to;
}

function isSessionBlocked(timestamp: number, windows: BlockedWindow[]): string | null {
  const etTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1000));
  for (const w of windows) {
    if (isInWindow(etTime, w.from, w.to)) return w.label;
  }
  return null;
}

export function toETString(timestamp: number): string {
  return new Date(timestamp * 1000)
    .toLocaleString('sv-SE', { timeZone: 'America/New_York' })
    .slice(0, 16);
}

// ── Outcome simulation ────────────────────────────────────────────────────────

interface SimulatedOutcome {
  result: TradeResult;
  closePrice: number | null;
  closeTime: number | null;
  pnl: number;
  actualRr: number | null;
}

function simulateOutcome(
  entry: number,
  sl: number,
  tp: number,
  side: 'BUY' | 'SELL',
  futureCandles: Candle[],
  riskAmount: number,
): SimulatedOutcome {
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const winPnl = riskAmount * (tpDist / slDist);

  for (const c of futureCandles) {
    if (side === 'BUY') {
      const hitSL = c.low <= sl;
      const hitTP = c.high >= tp;
      if (hitSL && hitTP) {
        if (c.open >= tp) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: winPnl, actualRr: tpDist / slDist };
        return { result: 'LOSS', closePrice: sl, closeTime: c.time, pnl: -riskAmount, actualRr: -1 };
      }
      if (hitSL) return { result: 'LOSS', closePrice: sl, closeTime: c.time, pnl: -riskAmount, actualRr: -1 };
      if (hitTP) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: winPnl, actualRr: tpDist / slDist };
    } else {
      const hitSL = c.high >= sl;
      const hitTP = c.low <= tp;
      if (hitSL && hitTP) {
        if (c.open <= tp) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: winPnl, actualRr: tpDist / slDist };
        return { result: 'LOSS', closePrice: sl, closeTime: c.time, pnl: -riskAmount, actualRr: -1 };
      }
      if (hitSL) return { result: 'LOSS', closePrice: sl, closeTime: c.time, pnl: -riskAmount, actualRr: -1 };
      if (hitTP) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: winPnl, actualRr: tpDist / slDist };
    }
  }
  return { result: 'OPEN', closePrice: null, closeTime: null, pnl: 0, actualRr: null };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function computeMetrics(trades: BacktestTrade[], initialBalance: number): BacktestMetrics {
  const completed = trades.filter((t) => t.result !== 'OPEN');
  const wins = trades.filter((t) => t.result === 'WIN');
  const losses = trades.filter((t) => t.result === 'LOSS');

  const winRate = completed.length > 0 ? (wins.length / completed.length) * 100 : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? 999 : 0;

  const avg = (arr: BacktestTrade[]) =>
    arr.length > 0 ? arr.reduce((s, t) => s + (t.actualRr ?? 0), 0) / arr.length : 0;

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  let peak = initialBalance;
  let bal = initialBalance;
  let maxDD = 0;
  for (const t of trades) {
    bal += t.pnl;
    if (bal > peak) peak = bal;
    const dd = peak > 0 ? ((peak - bal) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  let maxConsec = 0;
  let curConsec = 0;
  for (const t of trades) {
    if (t.result === 'LOSS') { curConsec++; if (curConsec > maxConsec) maxConsec = curConsec; }
    else if (t.result === 'WIN') curConsec = 0;
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    openTrades: trades.filter((t) => t.result === 'OPEN').length,
    winRate: r2(winRate),
    profitFactor: r2(profitFactor),
    avgRr: r2(avg(completed)),
    avgWinRr: r2(avg(wins)),
    avgLossRr: r2(avg(losses)),
    totalPnl: r2(totalPnl),
    maxDrawdownPct: r2(maxDD),
    maxConsecutiveLosses: maxConsec,
  };
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runBacktest(params: BacktestParams): Promise<BacktestReport> {
  const {
    symbol, from, to, initialBalance, riskPercent, cooldownMinutes,
    blockedHours, minFvgPoints, minSlPoints, m15ConfirmationEnabled,
  } = params;

  // Fetch starts WARM_UP_DAYS before `from` so the engine has context on day 1
  const fetchFrom = new Date(from + 'T00:00:00');
  fetchFrom.setDate(fetchFrom.getDate() - WARM_UP_DAYS);
  const fetchFromStr = fetchFrom.toISOString().slice(0, 10);

  // Fetch ends the day AFTER `to` to include the full last day
  const fetchTo = new Date(to + 'T00:00:00');
  fetchTo.setDate(fetchTo.getDate() + 1);
  const fetchToStr = fetchTo.toISOString().slice(0, 10);

  const fromTimestamp = new Date(from + 'T00:00:00').getTime() / 1000;

  // D1 bias needs ~1 year of history — fetch independently from M5/H1 warm-up window
  const d1FetchFrom = new Date(from + 'T00:00:00');
  d1FetchFrom.setDate(d1FetchFrom.getDate() - 365);
  const d1FetchFromStr = d1FetchFrom.toISOString().slice(0, 10);

  console.log(`\nFetching candles for ${symbol}  (${fetchFromStr} → ${fetchToStr})...`);

  const [m5Candles, h1Candles, m15Candles, d1Candles] = await Promise.all([
    fetchCandles(symbol, 'M5', fetchFromStr, fetchToStr),
    fetchCandles(symbol, 'H1', fetchFromStr, fetchToStr),
    m15ConfirmationEnabled
      ? fetchCandles(symbol, 'M15', fetchFromStr, fetchToStr)
      : Promise.resolve([] as Candle[]),
    fetchCandles(symbol, 'D1', d1FetchFromStr, fetchToStr),
  ]);

  console.log(`  M5:  ${m5Candles.length} candles`);
  console.log(`  H1:  ${h1Candles.length} candles`);
  if (m15ConfirmationEnabled) console.log(`  M15: ${m15Candles.length} candles`);
  console.log(`  D1:  ${d1Candles.length} candles`);

  // ── Strategy engine ─────────────────────────────────────────────────────────
  const strategy = new StrategyEngine();
  const biasEngine = new BiasEngine();
  const fvgDetector = new FVGDetector();
  const displacementDetector = new DisplacementDetector();
  const entryValidator = new EntryValidator();
  const positionSizing = new PositionSizing();

  strategy.initialize();

  const pendingSignals: Array<{ sweep: LiquiditySweep; mss: MSS }> = [];
  strategy.on('mssConfirmed', (data: { sweep: LiquiditySweep; mss: MSS }) => {
    pendingSignals.push(data);
  });

  // ── Replay state ────────────────────────────────────────────────────────────
  const trades: BacktestTrade[] = [];
  const lastSignalTime = new Map<'BULLISH' | 'BEARISH', number>();
  const cooldownSec = cooldownMinutes * 60;

  let balance = initialBalance;
  let lastTradeCloseTime = 0;
  let h1Ptr = 0;
  let m15Ptr = 0;
  let d1Ptr = 0;

  console.log(`\nReplaying ${m5Candles.length} M5 candles...`);

  for (let i = 0; i < m5Candles.length; i++) {
    const candle = m5Candles[i]!;
    const currentTime = candle.time;

    // ── Advance D1 pointer (D1 candle closes after 86400 s) ────────────────────
    while (d1Ptr < d1Candles.length && d1Candles[d1Ptr]!.time + 86400 <= currentTime) {
      d1Ptr++;
    }

    // ── Refresh EQH/EQL levels every hour (when a new H1 candle closes) ───────
    let h1Updated = false;
    while (h1Ptr < h1Candles.length && h1Candles[h1Ptr]!.time + 3600 <= currentTime) {
      h1Ptr++;
      h1Updated = true;
    }

    if (h1Updated && i >= 20) {
      const m5Window = m5Candles.slice(Math.max(0, i - 199), i + 1);
      const levels = [
        ...detectEqualHighs(m5Window),
        ...detectEqualLows(m5Window),
      ];
      strategy.getLiquidityEngine().addLevels(levels);
    }

    // ── Advance M15 pointer ─────────────────────────────────────────────────
    if (m15ConfirmationEnabled) {
      while (m15Ptr < m15Candles.length && m15Candles[m15Ptr]!.time + 900 <= currentTime) {
        m15Ptr++;
      }
    }

    // ── Feed candle to strategy ─────────────────────────────────────────────
    pendingSignals.length = 0;
    strategy.processCandle(candle);

    // ── Skip conditions ─────────────────────────────────────────────────────
    if (i < WARM_UP_CANDLES) continue;
    if (currentTime < fromTimestamp) continue;
    if (pendingSignals.length === 0) continue;
    if (currentTime <= lastTradeCloseTime) continue;

    const h1Window = h1Candles.slice(0, h1Ptr);
    if (h1Window.length < 5) continue;

    // ── Evaluate each signal (take first valid one per candle) ──────────────
    for (const signal of pendingSignals) {
      const dir = signal.mss.direction;

      if (isSessionBlocked(currentTime, blockedHours)) continue;

      const elapsed = currentTime - (lastSignalTime.get(dir) ?? 0);
      if (elapsed < cooldownSec) continue;

      const htfBias = biasEngine.analyze(d1Candles.slice(0, d1Ptr));
      if (htfBias === 'RANGE') continue;
      if (htfBias !== dir) continue;

      if (m15ConfirmationEnabled && m15Ptr >= 5) {
        const m15Bias = biasEngine.analyze(m15Candles.slice(0, m15Ptr));
        if (m15Bias !== htfBias) continue;
      }

      // Search FVG in the last 7 candles — the FVG forms during the displacement candle
      // (2–5 candles before MSS confirmation), not at the MSS candle itself.
      const fvgWindow = m5Candles.slice(Math.max(0, i - 6), i + 1);
      let fvg = null;
      for (let k = fvgWindow.length - 1; k >= 2 && !fvg; k--) {
        const slice = fvgWindow.slice(k - 2, k + 1);
        fvg = dir === 'BULLISH' ? fvgDetector.detectBullish(slice) : fvgDetector.detectBearish(slice);
      }

      // Check displacement in the last 5 candles — the strong impulse candle precedes the MSS.
      const dispWindow = m5Candles.slice(Math.max(0, i - 4), i + 1);
      const displacement = dispWindow.map(c => displacementDetector.detect(c)).find(Boolean) ?? null;
      const sweepDir = signal.sweep.direction === 'bullish' ? ('BULLISH' as const) : ('BEARISH' as const);

      const valid = entryValidator.validate({
        htfBias,
        sweepDirection: sweepDir,
        mssDirection: dir,
        hasDisplacement: !!displacement,
        hasFVG: !!fvg,
      });
      if (!valid) continue;
      if (fvg && minFvgPoints > 0 && fvg.size < minFvgPoints) continue;

      // ── Price levels ──────────────────────────────────────────────────────
      // FVG validates setup quality; execution is always market, not limit at FVG midpoint
      const entryPrice = candle.close;
      const sweepRange = signal.sweep.sweepCandleHigh - signal.sweep.sweepCandleLow;
      const buffer = sweepRange * SL_BUFFER_RATIO;
      const stopLoss = dir === 'BULLISH'
        ? signal.sweep.sweepCandleLow - buffer
        : signal.sweep.sweepCandleHigh + buffer;
      const slDist = Math.abs(entryPrice - stopLoss);
      if (minSlPoints > 0 && slDist < minSlPoints) continue;

      const takeProfit = dir === 'BULLISH'
        ? entryPrice + slDist * 2
        : entryPrice - slDist * 2;

      const sizing = positionSizing.calculate({
        accountBalance: balance,
        riskPercent,
        entryPrice,
        stopLoss,
        target: takeProfit,
      });
      if (sizing.riskRewardRatio < 2) continue;

      const volume = Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(sizing.positionSize * 10) / 10));
      const side = dir === 'BULLISH' ? ('BUY' as const) : ('SELL' as const);

      // ── Simulate outcome ──────────────────────────────────────────────────
      const outcome = simulateOutcome(
        entryPrice, stopLoss, takeProfit, side,
        m5Candles.slice(i + 1, i + 1 + MAX_LOOKAHEAD),
        sizing.riskAmount,
      );

      balance += outcome.pnl;
      lastSignalTime.set(dir, currentTime);
      if (outcome.closeTime !== null) lastTradeCloseTime = outcome.closeTime;

      trades.push({
        tradeNumber: trades.length + 1,
        direction: dir,
        side,
        openTime: currentTime,
        closeTime: outcome.closeTime,
        openTimeISO: toETString(currentTime),
        closeTimeISO: outcome.closeTime ? toETString(outcome.closeTime) : null,
        entry: Math.round(entryPrice * 100) / 100,
        sl: Math.round(stopLoss * 100) / 100,
        tp: Math.round(takeProfit * 100) / 100,
        plannedRr: Math.round(sizing.riskRewardRatio * 100) / 100,
        actualRr: outcome.actualRr !== null ? Math.round(outcome.actualRr * 100) / 100 : null,
        result: outcome.result,
        pnl: Math.round(outcome.pnl * 100) / 100,
      });

      void volume;
      break;
    }
  }

  const metrics = computeMetrics(trades, initialBalance);

  return {
    symbol,
    from,
    to,
    initialBalance,
    finalBalance: Math.round(balance * 100) / 100,
    riskPercent,
    cooldownMinutes,
    metrics,
    trades,
    generatedAt: new Date().toISOString(),
  };
}
