import type { Candle } from '../../services/mt5/mt5.types';

export class ChoppinessEngine {
  // CI = 100 * log10( sum(TR, n) / (highestHigh(n) - lowestLow(n)) ) / log10(n)
  // > 61.8 → choppy/ranging   < 38.2 → strongly trending
  last(candles: Candle[], period = 14): number | null {
    if (candles.length < period + 1) return null;

    const window = candles.slice(candles.length - period - 1);

    let trSum = 0;
    let highest = -Infinity;
    let lowest  =  Infinity;

    for (let i = 1; i < window.length; i++) {
      const cur  = window[i]!;
      const prev = window[i - 1]!;
      const tr   = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low  - prev.close),
      );
      trSum  += tr;
      if (cur.high > highest) highest = cur.high;
      if (cur.low  < lowest)  lowest  = cur.low;
    }

    const range = highest - lowest;
    if (range === 0) return null;

    const ci = 100 * (Math.log10(trSum / range) / Math.log10(period));
    return Math.round(ci * 100) / 100;
  }
}
