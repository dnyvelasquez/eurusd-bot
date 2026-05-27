import { Candle } from '../../services/mt5/mt5.types';

export interface BBResult {
  upper: number;
  middle: number;  // SMA(period)
  lower: number;
  bandwidth: number;  // (upper - lower) / middle * 100
}

export class BollingerEngine {
  calc(candles: Candle[], period: number, stdDevMultiplier = 2): BBResult[] {
    if (candles.length < period) return [];
    const results: BBResult[] = [];
    for (let i = period - 1; i < candles.length; i++) {
      const slice = candles.slice(i - period + 1, i + 1);
      const sma = slice.reduce((s, c) => s + c.close, 0) / period;
      const variance = slice.reduce((s, c) => s + (c.close - sma) ** 2, 0) / period;
      const sigma = Math.sqrt(variance);
      const upper = sma + stdDevMultiplier * sigma;
      const lower = sma - stdDevMultiplier * sigma;
      results.push({ upper, middle: sma, lower, bandwidth: ((upper - lower) / sma) * 100 });
    }
    return results;
  }

  last(candles: Candle[], period: number, stdDevMultiplier = 2): BBResult | null {
    const arr = this.calc(candles, period);
    return arr.length > 0 ? arr[arr.length - 1]! : null;
  }
}
