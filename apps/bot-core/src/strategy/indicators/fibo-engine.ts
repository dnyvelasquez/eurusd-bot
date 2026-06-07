import { Candle } from '../../services/mt5/mt5.types';
import { SwingDetector } from '../structure/swing-detector';

export interface FiboLevel {
  ratio: number;
  price: number;
}

export interface FiboAnalysis {
  direction: 'BULLISH' | 'BEARISH';
  swingLow: number;
  swingHigh: number;
  levels: FiboLevel[];
  nearestLevel: FiboLevel | null;
}

const DEFAULT_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

export class FiboEngine {
  private readonly swingDetector = new SwingDetector();

  analyze(
    candles: Candle[],
    currentPrice: number,
    proximityPoints: number,
    ratios = DEFAULT_RATIOS,
  ): FiboAnalysis | null {
    const swings = this.swingDetector.detectSwings(candles);
    if (swings.length < 2) return null;

    const lastHigh = [...swings].reverse().find(s => s.type === 'HIGH');
    const lastLow  = [...swings].reverse().find(s => s.type === 'LOW');
    if (!lastHigh || !lastLow) return null;

    const swingHigh = lastHigh.price;
    const swingLow  = lastLow.price;
    const range = swingHigh - swingLow;
    if (range <= 0) return null;

    // If the last swing was a HIGH the prior leg was up → price may be pulling back → BULLISH setup
    // If the last swing was a LOW the prior leg was down → price may be bouncing → BEARISH setup
    const direction: 'BULLISH' | 'BEARISH' =
      lastHigh.index > lastLow.index ? 'BULLISH' : 'BEARISH';

    const levels: FiboLevel[] = ratios.map(r => ({
      ratio: r,
      price: direction === 'BULLISH'
        ? swingHigh - r * range   // pullback support levels
        : swingLow  + r * range,  // bounce resistance levels
    }));

    const inRange = levels.filter(l => Math.abs(l.price - currentPrice) <= proximityPoints);
    const nearestLevel = inRange.length === 0 ? null : inRange.reduce((a, b) =>
      Math.abs(a.price - currentPrice) <= Math.abs(b.price - currentPrice) ? a : b,
    );

    return { direction, swingLow, swingHigh, levels, nearestLevel };
  }
}
