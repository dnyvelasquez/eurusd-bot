import { FairValueGap } from './fvg-types';

interface Candle {
  time: number;
  high: number;
  low: number;
}

export class FVGDetector {
  detectBullish(
    candles: Candle[],
  ): FairValueGap | null {
    if (candles.length < 3) {
      return null;
    }

    const [first, middle, third] = candles;

    const hasGap =
      first.high < third.low;

    if (!hasGap) {
      return null;
    }

    return {
      direction: 'BULLISH',

      startPrice: first.high,

      endPrice: third.low,

      candleTime: middle.time,

      size: third.low - first.high,
    };
  }

  detectBearish(
    candles: Candle[],
  ): FairValueGap | null {
    if (candles.length < 3) {
      return null;
    }

    const [first, middle, third] = candles;

    const hasGap =
      first.low > third.high;

    if (!hasGap) {
      return null;
    }

    return {
      direction: 'BEARISH',

      startPrice: third.high,

      endPrice: first.low,

      candleTime: middle.time,

      size: first.low - third.high,
    };
  }
}