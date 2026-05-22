import { MSS } from './mss-types';

interface SwingPoint {
  price: number;
  time: number;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class MSSDetector {
  detectBearishMSS(
    candle: Candle,
    lastSwingLow: SwingPoint,
  ): MSS | null {
    const broken = candle.close < lastSwingLow.price;

    if (!broken) {
      return null;
    }

    return {
      direction: 'BEARISH',

      brokenPrice: lastSwingLow.price,

      breakTime: candle.time,

      displacementStrength:
        Math.abs(candle.open - candle.close),

      referenceSwingTime: lastSwingLow.time,
    };
  }

  detectBullishMSS(
    candle: Candle,
    lastSwingHigh: SwingPoint,
  ): MSS | null {
    const broken = candle.close > lastSwingHigh.price;

    if (!broken) {
      return null;
    }

    return {
      direction: 'BULLISH',

      brokenPrice: lastSwingHigh.price,

      breakTime: candle.time,

      displacementStrength:
        Math.abs(candle.open - candle.close),

      referenceSwingTime: lastSwingHigh.time,
    };
  }
}