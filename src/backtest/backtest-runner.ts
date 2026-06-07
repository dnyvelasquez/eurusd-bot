import axios from 'axios';

import { BiasEngine } from '@bot-core/strategy/bias/bias-engine';
import { ZoneEngine } from '@bot-core/strategy/zones/zone-engine';
import { MomentumEngine } from '@bot-core/strategy/momentum/momentum-engine';
import { FVGDetector } from '@bot-core/strategy/fvg/fvg-detector';
import { DisplacementDetector } from '@bot-core/strategy/fvg/displacement-detector';
import { EntryValidator } from '@bot-core/strategy/entry/entry-validator';
import { PositionSizing } from '@bot-core/strategy/risk/position-sizing';
import { EMAEngine } from '@bot-core/strategy/indicators/ema-engine';
import { MACDEngine } from '@bot-core/strategy/indicators/macd-engine';
import { ADXEngine } from '@bot-core/strategy/indicators/adx-engine';
import { ChoppinessEngine } from '@bot-core/strategy/indicators/choppiness-engine';
import { SMAEngine } from '@bot-core/strategy/indicators/sma-engine';
import type { Candle } from '@bot-core/services/mt5/mt5.types';

import type { BacktestTrade, BacktestReport, BacktestMetrics, TradeResult, SignalType } from './backtest.types';

const BRIDGE_URL = 'http://127.0.0.1:8001/api/trading';
const WARM_UP_DAYS = 5;
const WARM_UP_CANDLES = 100;
const MAX_LOOKAHEAD = 500;
const MAX_VOLUME = 20.0;
const MIN_VOLUME = 0.1;

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
  zoneProximityPoints: number;
  zoneSlBufferPoints: number;
  emaSpreadMin: number;
  epUseM15Align: boolean;
  epUseMacdSlope: boolean;
  maxConsecLosses: number;
  beAtPoints: number;   // 0=off, -1=1R mode, >0=fixed points
  beBuffer: number;
  partialTpEnabled: boolean;
  enableZB?: boolean;
  enableEP?: boolean;
  epMinSlPoints?: number;
  epSkipMonday?: boolean;
  epMinHour?: number;
  symbolTickSize?: number;
  symbolTickValue?: number;
  epMaxHour?: number;
  epAdxPeriod?: number;
  epAdxMin?: number;
  epH1AdxMin?: number;
  epH4Align?: boolean;
  ciPeriod?: number;
  ciMax?: number;       // 0=off; >0 skip signals when H4 CI exceeds this (e.g. 61.8)
  ciBuyOnly?: boolean;  // when true, only skip BUY signals in choppy regime
  maxConsecLossDays?: number;
  epD1Align?: boolean;  // skip EP signals that oppose D1 EMA8 vs EMA34 direction
  epDiTf?: 'H4' | 'D1'; // timeframe for +DI/-DI directional filter ('' = off)
  epDiMinGap?: number;  // minimum +DI/-DI gap to enforce direction (0 = any gap)
  spreadPoints?: number; // ask-bid spread: added to BUY entry, subtracted from SELL entry
  epAdxMax?: number;    // 0=off; >0 skip EP signals when H4 ADX exceeds this (overextended trend)
  tpRr?: number;        // TP multiplier on SL distance (default 2 = 2:1 R:R)
  trailRr?: number;     // 0=off; >0 trail SL at trailRr × slDist behind price peak
  maxDailyLosses?: number; // 0=off; >0 stop trading for the rest of the day after N losses
  smaTrendPeriod?: number; // 0=off; >0 gate all signals by price vs SMA on smaTrendTf
  smaTrendTf?: 'D1' | 'H4' | 'H1';
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
  beAtPoints = 0,   // 0 = disabled, -1 = use 1R (slDist) as trigger
  beBuffer = 0,
  partialTp = false,
  trailRr = 0,      // 0 = disabled; >0 = trail SL at trailRr × slDist behind peak
): SimulatedOutcome {
  const origSlDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const trailDist = trailRr > 0 ? origSlDist * trailRr : 0;

  const effectiveBeTrigger = beAtPoints === -1 ? origSlDist : beAtPoints;

  let currentSL = sl;
  let beTriggered = false;
  let partialDone = false;
  let lockedPnl = 0;
  let remainingRisk = riskAmount;
  let peakFavor = 0;

  // Compute P&L and result when stopped out at currentSL
  const stopOutcome = (): SimulatedOutcome & { time: number } => { throw new Error('unused'); };
  void stopOutcome;

  for (const c of futureCandles) {
    // Track peak favorable move across the candle
    const candleFavor = side === 'BUY' ? c.high - entry : entry - c.low;
    if (candleFavor > peakFavor) peakFavor = candleFavor;

    // BE trigger
    if (effectiveBeTrigger > 0 && !beTriggered && peakFavor >= effectiveBeTrigger) {
      beTriggered = true;
      currentSL = side === 'BUY' ? entry + beBuffer : entry - beBuffer;
      if (partialTp && !partialDone) {
        partialDone = true;
        lockedPnl = 0.5 * riskAmount * (effectiveBeTrigger / origSlDist);
        remainingRisk = 0.5 * riskAmount;
      }
    }

    // Trailing SL: advance in trade's favor as peak grows
    if (trailDist > 0 && peakFavor > trailDist) {
      const candidate = side === 'BUY'
        ? entry + peakFavor - trailDist
        : entry - peakFavor + trailDist;
      if (side === 'BUY' && candidate > currentSL) currentSL = candidate;
      if (side === 'SELL' && candidate < currentSL) currentSL = candidate;
    }

    // Dynamic stop P&L based on current SL position
    const slFactor = side === 'BUY'
      ? (currentSL - entry) / origSlDist
      : (entry - currentSL) / origSlDist;
    const stopPnl = lockedPnl + remainingRisk * slFactor;
    const stopRr  = stopPnl / riskAmount;
    const stopRes: TradeResult = stopPnl >= 0 ? 'WIN' : 'LOSS';

    const fullWinPnl = lockedPnl + remainingRisk * (tpDist / origSlDist);
    const fullWinRr  = fullWinPnl / riskAmount;

    if (side === 'BUY') {
      const hitSL = c.low <= currentSL;
      const hitTP = c.high >= tp;
      if (hitSL && hitTP) {
        if (c.open >= tp) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: fullWinPnl, actualRr: fullWinRr };
        return { result: stopRes, closePrice: currentSL, closeTime: c.time, pnl: stopPnl, actualRr: stopRr };
      }
      if (hitSL) return { result: stopRes, closePrice: currentSL, closeTime: c.time, pnl: stopPnl, actualRr: stopRr };
      if (hitTP) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: fullWinPnl, actualRr: fullWinRr };
    } else {
      const hitSL = c.high >= currentSL;
      const hitTP = c.low <= tp;
      if (hitSL && hitTP) {
        if (c.open <= tp) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: fullWinPnl, actualRr: fullWinRr };
        return { result: stopRes, closePrice: currentSL, closeTime: c.time, pnl: stopPnl, actualRr: stopRr };
      }
      if (hitSL) return { result: stopRes, closePrice: currentSL, closeTime: c.time, pnl: stopPnl, actualRr: stopRr };
      if (hitTP) return { result: 'WIN', closePrice: tp, closeTime: c.time, pnl: fullWinPnl, actualRr: fullWinRr };
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
    blockedHours, minFvgPoints, minSlPoints, zoneProximityPoints, zoneSlBufferPoints,
    emaSpreadMin, epUseM15Align, epUseMacdSlope,
    maxConsecLosses,
    beAtPoints, beBuffer, partialTpEnabled,
    enableZB = true, enableEP = true,
    epMinSlPoints = 0, epSkipMonday = false, epMinHour = 0, epMaxHour = 0,
    epAdxPeriod = 14, epAdxMin = 0, epH1AdxMin = 0, epH4Align = false,
    ciPeriod = 14, ciMax = 0, ciBuyOnly = false,
    maxConsecLossDays = 0,
    epD1Align = false, epDiTf, epDiMinGap = 0,
    spreadPoints = 0,
    epAdxMax = 0,
    tpRr = 2,
    trailRr = 0,
    maxDailyLosses = 0,
    smaTrendPeriod = 0,
    smaTrendTf = 'D1',
  } = params;

  const fetchFrom = new Date(from + 'T00:00:00');
  fetchFrom.setDate(fetchFrom.getDate() - WARM_UP_DAYS);
  const fetchFromStr = fetchFrom.toISOString().slice(0, 10);

  const fetchTo = new Date(to + 'T00:00:00');
  fetchTo.setDate(fetchTo.getDate() + 1);
  const fetchToStr = fetchTo.toISOString().slice(0, 10);

  const fromTimestamp = new Date(from + 'T00:00:00').getTime() / 1000;

  // D1 bias needs ~1 year of history
  const d1FetchFrom = new Date(from + 'T00:00:00');
  d1FetchFrom.setDate(d1FetchFrom.getDate() - 365);
  const d1FetchFromStr = d1FetchFrom.toISOString().slice(0, 10);

  console.log(`\nFetching candles for ${symbol}  (${fetchFromStr} → ${fetchToStr})...`);

  const [m5Candles, h1Candles, h4Candles, m15Candles, d1Candles] = await Promise.all([
    fetchCandles(symbol, 'M5', fetchFromStr, fetchToStr),
    fetchCandles(symbol, 'H1', fetchFromStr, fetchToStr),
    fetchCandles(symbol, 'H4', fetchFromStr, fetchToStr),
    fetchCandles(symbol, 'M15', fetchFromStr, fetchToStr),
    fetchCandles(symbol, 'D1', d1FetchFromStr, fetchToStr),
  ]);

  console.log(`  M5:  ${m5Candles.length} candles`);
  console.log(`  M15: ${m15Candles.length} candles`);
  console.log(`  H1:  ${h1Candles.length} candles`);
  console.log(`  H4:  ${h4Candles.length} candles`);
  console.log(`  D1:  ${d1Candles.length} candles`);

  // ── Strategy engines ────────────────────────────────────────────────────────
  const biasEngine = new BiasEngine();
  const zoneEngine = new ZoneEngine();
  const momentumEngine = new MomentumEngine();
  const fvgDetector = new FVGDetector();
  const displacementDetector = new DisplacementDetector();
  const entryValidator = new EntryValidator();
  const positionSizing = new PositionSizing();
  const emaEngine = new EMAEngine();
  const macdEngine = new MACDEngine();
  const adxEngine = new ADXEngine();
  const choppinessEngine = new ChoppinessEngine();
  const smaEngine = new SMAEngine();

  // ── Signal evaluators ────────────────────────────────────────────────────────

  interface SignalCandidate {
    signalType: SignalType;
    direction: 'BULLISH' | 'BEARISH';
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
  }

  function evalM5Entry(
    direction: 'BULLISH' | 'BEARISH',
    zoneLevel: number,
    m5Slice: Candle[],
    i: number,
    signalType: SignalType,
  ): SignalCandidate | null {
    const fvgWindow = m5Slice.slice(Math.max(0, i - 6), i + 1);
    let fvg = null;
    for (let k = fvgWindow.length - 1; k >= 2 && !fvg; k--) {
      const slice = fvgWindow.slice(k - 2, k + 1);
      fvg = direction === 'BULLISH' ? fvgDetector.detectBullish(slice) : fvgDetector.detectBearish(slice);
    }
    if (fvg && minFvgPoints > 0 && fvg.size < minFvgPoints) return null;

    const dispWindow = m5Slice.slice(Math.max(0, i - 4), i + 1);
    const displacement = dispWindow.map(c => displacementDetector.detect(c)).find(Boolean) ?? null;

    const momentum = momentumEngine.analyze(m5Slice.slice(0, i + 1)); // placeholder — caller passes M15
    // Validation uses caller-supplied momentum; re-use same validator
    const valid = entryValidator.validate({
      htfBias: direction,
      m15Momentum: direction, // caller already confirmed momentum alignment
      hasDisplacement: !!displacement,
      hasFVG: !!fvg,
    });
    if (!valid) return null;

    const entryPrice = m5Slice[i]!.close;
    const stopLoss = direction === 'BULLISH'
      ? zoneLevel - zoneSlBufferPoints
      : zoneLevel + zoneSlBufferPoints;
    const slDist = Math.abs(entryPrice - stopLoss);
    if (minSlPoints > 0 && slDist < minSlPoints) return null;

    return {
      signalType,
      direction,
      entryPrice,
      stopLoss,
      takeProfit: direction === 'BULLISH' ? entryPrice + slDist * tpRr : entryPrice - slDist * tpRr,
    };
  }

  function evalZoneBounce(
    d1: Candle[], h4: Candle[], h1: Candle[], m15: Candle[],
    m5All: Candle[], i: number,
  ): SignalCandidate | null {
    if (d1.length < 10 || h4.length < 10 || h1.length < 10 || m15.length < 10) return null;
    const currentPrice = m5All[i]!.close;

    const zones = zoneEngine.getZones(d1, h4, h1, m15);
    const activeZone = zoneEngine.findActiveZone(zones, currentPrice, zoneProximityPoints);
    if (!activeZone) return null;

    const htfBias = biasEngine.analyzeMultiTF(d1, h4, h1);
    if (htfBias === 'RANGE') return null;

    const zoneAligned =
      (htfBias === 'BULLISH' && activeZone.type === 'SUPPORT') ||
      (htfBias === 'BEARISH' && activeZone.type === 'RESISTANCE');
    if (!zoneAligned) return null;

    const momentum = momentumEngine.analyze(m15);
    if (momentum.direction === 'NEUTRAL' || momentum.direction !== htfBias) return null;

    return evalM5Entry(htfBias, activeZone.level, m5All, i, 'ZONE');
  }

  function evalEMAPullback(
    h4: Candle[], h1: Candle[], m15: Candle[], m5All: Candle[], i: number,
    useM15Align: boolean, useMacdSlope: boolean, candleTs: number,
  ): SignalCandidate | null {
    // EP-specific filters: Monday and early-session exclusions
    if (epSkipMonday || epMinHour > 0 || epMaxHour > 0) {
      const dtET = new Date(candleTs * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false });
      const [weekday, hourStr] = dtET.split(', ');
      const hourNum = parseInt(hourStr ?? '0', 10);
      if (epSkipMonday && weekday === 'Mon') return null;
      if (epMinHour > 0 && hourNum < epMinHour) return null;
      if (epMaxHour > 0 && hourNum >= epMaxHour) return null;
    }
    if (h1.length < 40 || m15.length < 40) return null;

    // Trend direction from H1 EMA 8 vs EMA 34
    const h1Ema8 = emaEngine.last(h1, 8);
    const h1Ema34 = emaEngine.last(h1, 34);
    if (h1Ema8 === null || h1Ema34 === null) return null;
    const direction: 'BULLISH' | 'BEARISH' = h1Ema8 > h1Ema34 ? 'BULLISH' : 'BEARISH';

    // Reject choppy H1 — spread must be wide enough to confirm real trend
    if (emaSpreadMin > 0 && Math.abs(h1Ema8 - h1Ema34) < emaSpreadMin) return null;

    // [H4] H4 EMA 8 must agree with H1 direction (top-down alignment)
    if (epH4Align) {
      const h4Ema8  = emaEngine.last(h4, 8);
      const h4Ema34 = emaEngine.last(h4, 34);
      if (h4Ema8 === null || h4Ema34 === null) return null;
      if (direction === 'BULLISH' && h4Ema8 < h4Ema34) return null;
      if (direction === 'BEARISH' && h4Ema8 > h4Ema34) return null;
    }

    // M15 EMA 34 as dynamic support/resistance
    const m15Ema34 = emaEngine.last(m15, 34);
    if (m15Ema34 === null) return null;

    // [F1] M15 EMA 8 must still be on the trend side of EMA 34 (shallow pullback)
    if (useM15Align) {
      const m15Ema8 = emaEngine.last(m15, 8);
      if (m15Ema8 === null) return null;
      if (direction === 'BULLISH' && m15Ema8 < m15Ema34) return null;
      if (direction === 'BEARISH' && m15Ema8 > m15Ema34) return null;
    }

    const currentPrice = m5All[i]!.close;

    const slAnchor = m15Ema34;
    if (Math.abs(currentPrice - m15Ema34) > zoneProximityPoints) return null;

    // ADX on H4: skip if market is ranging (trend strength too low)
    if (epAdxMin > 0) {
      const adx = adxEngine.last(h4, epAdxPeriod);
      if (adx === null || adx < epAdxMin) return null;
    }

    // ADX on H4: skip if trend is overextended (too strong = mean-reversion risk)
    if (epAdxMax > 0) {
      const adx = adxEngine.last(h4, epAdxPeriod);
      if (adx !== null && adx > epAdxMax) return null;
    }

    // ADX on H1: skip if H1 trend lacks conviction
    if (epH1AdxMin > 0) {
      const adxH1 = adxEngine.last(h1, epAdxPeriod);
      if (adxH1 === null || adxH1 < epH1AdxMin) return null;
    }

    // MACD histogram on M15 must confirm trend direction
    const macd = macdEngine.analyze(m15);
    if (!macd) return null;
    if (direction === 'BULLISH' && macd.histogram <= 0) return null;
    if (direction === 'BEARISH' && macd.histogram >= 0) return null;

    // [F2] MACD histogram must be accelerating (slope in trend direction)
    if (useMacdSlope) {
      const slope = macdEngine.histogramSlope(m15);
      if (!slope) return null;
      const [prev, cur] = slope;
      if (direction === 'BULLISH' && cur <= prev) return null;
      if (direction === 'BEARISH' && cur >= prev) return null;
    }

    // Entry at M5 close; SL beyond slAnchor (M15 EMA34) ± buffer
    const entryPrice = currentPrice;
    const stopLoss = direction === 'BULLISH'
      ? slAnchor - zoneSlBufferPoints
      : slAnchor + zoneSlBufferPoints;
    const slDist = Math.abs(entryPrice - stopLoss);
    if (minSlPoints > 0 && slDist < minSlPoints) return null;
    if (epMinSlPoints > 0 && slDist < epMinSlPoints) return null;

    return {
      signalType: 'EMA_PB',
      direction,
      entryPrice,
      stopLoss,
      takeProfit: direction === 'BULLISH' ? entryPrice + slDist * tpRr : entryPrice - slDist * tpRr,
    };
  }

  // ── Replay state ──────────────────────────────────────────────────────────
  const trades: BacktestTrade[] = [];
  const lastSignalTime = new Map<'BULLISH' | 'BEARISH', number>();
  const cooldownSec = cooldownMinutes * 60;
  let balance = initialBalance;
  let lastTradeCloseTime = 0;
  let h1Ptr = 0; let h4Ptr = 0; let m15Ptr = 0; let d1Ptr = 0;

  const etDay    = (ts: number) => new Date(ts * 1000).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10);
  const isMonday = (ts: number) => new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' }) === 'Mon';
  let currentDayKey  = '';
  let dayRefBalance  = initialBalance;
  let consecLosses   = 0;
  let circuitDay     = '';
  let consecBadDays  = 0;
  let pauseUntilMon  = false;
  let dailyLossCount = 0;

  console.log(`\nReplaying ${m5Candles.length} M5 candles...`);

  for (let i = 0; i < m5Candles.length; i++) {
    const candle = m5Candles[i]!;
    const currentTime = candle.time;

    while (d1Ptr < d1Candles.length && d1Candles[d1Ptr]!.time + 86400 <= currentTime) d1Ptr++;
    while (h4Ptr < h4Candles.length && h4Candles[h4Ptr]!.time + 14400 <= currentTime) h4Ptr++;
    while (h1Ptr < h1Candles.length && h1Candles[h1Ptr]!.time + 3600 <= currentTime) h1Ptr++;
    while (m15Ptr < m15Candles.length && m15Candles[m15Ptr]!.time + 900 <= currentTime) m15Ptr++;

    if (i < WARM_UP_CANDLES) continue;
    if (currentTime < fromTimestamp) continue;
    if (currentTime <= lastTradeCloseTime) continue;
    if (isSessionBlocked(currentTime, blockedHours)) continue;

    const dk = etDay(currentTime);
    if (dk !== currentDayKey) {
      if (currentDayKey !== '') {
        const dayWasNegative = balance < dayRefBalance;
        if (dayWasNegative) {
          consecBadDays++;
          if (maxConsecLossDays > 0 && consecBadDays >= maxConsecLossDays) pauseUntilMon = true;
        } else {
          consecBadDays = 0;
        }
      }
      if (isMonday(currentTime)) { consecBadDays = 0; pauseUntilMon = false; consecLosses = 0; }
      currentDayKey = dk;
      dayRefBalance = balance;
      circuitDay = '';
      dailyLossCount = 0;
      if (maxConsecLosses > 0 && consecLosses >= maxConsecLosses) circuitDay = dk;
    }
    if (pauseUntilMon) continue;
    if (maxConsecLosses > 0 && circuitDay === dk) continue;
    if (maxDailyLosses > 0 && dailyLossCount >= maxDailyLosses) continue;

    const d1Window  = d1Candles.slice(0, d1Ptr);
    const h4Window  = h4Candles.slice(0, h4Ptr);
    const h1Window  = h1Candles.slice(0, h1Ptr);
    const m15Window = m15Candles.slice(0, m15Ptr);

    let ciChoppy = false;
    if (ciMax > 0 && h4Window.length >= ciPeriod + 1) {
      const ci = choppinessEngine.last(h4Window, ciPeriod);
      ciChoppy = ci !== null && ci > ciMax;
    }

    const signal =
      (enableZB ? evalZoneBounce(d1Window, h4Window, h1Window, m15Window, m5Candles, i) : null) ??
      (enableEP ? evalEMAPullback(h4Window, h1Window, m15Window, m5Candles, i, epUseM15Align, epUseMacdSlope, candle.time) : null);

    if (!signal) continue;

    if (ciChoppy && (!ciBuyOnly || signal.direction === 'BULLISH')) continue;

    if (epD1Align && d1Window.length >= 35) {
      const d1Ema8  = emaEngine.last(d1Window, 8);
      const d1Ema34 = emaEngine.last(d1Window, 34);
      if (d1Ema8 !== null && d1Ema34 !== null) {
        if (signal.direction === 'BULLISH' && d1Ema8 < d1Ema34) continue;
        if (signal.direction === 'BEARISH' && d1Ema8 > d1Ema34) continue;
      }
    }

    if (epDiTf) {
      const diCandles = epDiTf === 'H4' ? h4Window : d1Window;
      const di = adxEngine.lastWithDI(diCandles, epAdxPeriod);
      if (di !== null) {
        const gap = di.pdi - di.ndi;
        if (gap < -epDiMinGap && signal.direction === 'BULLISH') continue;
        if (gap > epDiMinGap  && signal.direction === 'BEARISH') continue;
      }
    }

    if (smaTrendPeriod > 0) {
      const smaTfC = smaTrendTf === 'D1' ? d1Window : smaTrendTf === 'H4' ? h4Window : h1Window;
      const sma = smaEngine.last(smaTfC, smaTrendPeriod);
      if (sma !== null) {
        const price = m5Candles[i]!.close;
        if (signal.direction === 'BULLISH' && price < sma) continue;
        if (signal.direction === 'BEARISH' && price > sma) continue;
      }
    }

    const elapsed = currentTime - (lastSignalTime.get(signal.direction) ?? 0);
    if (elapsed < cooldownSec) continue;

    const { direction, entryPrice: signalEntry, stopLoss, takeProfit } = signal;
    const sizing = positionSizing.calculate({
      accountBalance: balance,
      riskPercent,
      entryPrice: signalEntry,
      stopLoss,
      target: takeProfit,
      tradeTickSize: params.symbolTickSize ?? 0.00001,
      tradeTickValue: params.symbolTickValue ?? 1.0,
    });
    if (sizing.riskRewardRatio < 2) continue;

    const entryPrice = signalEntry + (direction === 'BULLISH' ? spreadPoints : -spreadPoints);
    const volume = Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(sizing.positionSize * 10) / 10));
    const side = direction === 'BULLISH' ? ('BUY' as const) : ('SELL' as const);

    const outcome = simulateOutcome(
      entryPrice, stopLoss, takeProfit, side,
      m5Candles.slice(i + 1, i + 1 + MAX_LOOKAHEAD),
      sizing.riskAmount,
      beAtPoints,
      beBuffer,
      partialTpEnabled,
      trailRr,
    );

    balance += outcome.pnl;
    lastSignalTime.set(direction, currentTime);
    if (outcome.closeTime !== null) lastTradeCloseTime = outcome.closeTime;

    if (outcome.result === 'LOSS') {
      consecLosses++;
      dailyLossCount++;
      if (maxConsecLosses > 0 && consecLosses >= maxConsecLosses) circuitDay = dk;
    } else if (outcome.result === 'WIN') {
      consecLosses = 0;
    }

    trades.push({
      tradeNumber: trades.length + 1,
      signalType: signal.signalType,
      direction,
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
    spreadPoints,
    metrics,
    trades,
    generatedAt: new Date().toISOString(),
  };
}
