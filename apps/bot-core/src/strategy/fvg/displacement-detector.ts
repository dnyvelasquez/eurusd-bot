import { Displacement } from './fvg-types';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class DisplacementDetector {
  detect(
    candle: Candle,
  ): Displacement | null {
    const bodySize = Math.abs(
      candle.close - candle.open,
    );

    const range = candle.high - candle.low;

    if (range === 0) {
      return null;
    }

    const strength = bodySize / range;

    const isStrong = strength >= 0.7;

    if (!isStrong) {
      return null;
    }

    return {
      direction:
        candle.close > candle.open
          ? 'BULLISH'
          : 'BEARISH',

      candleTime: candle.time,

      bodySize,

      range,

      strength,
    };
  }
}