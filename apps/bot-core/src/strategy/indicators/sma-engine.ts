import type { Candle } from '../../services/mt5/mt5.types';

export class SMAEngine {
  calc(candles: Candle[], period: number): number[] {
    if (candles.length < period) return [];
    const result: number[] = [];
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += candles[j]!.close;
      result.push(sum / period);
    }
    return result;
  }

  last(candles: Candle[], period: number): number | null {
    if (candles.length < period) return null;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) sum += candles[i]!.close;
    return sum / period;
  }
}
