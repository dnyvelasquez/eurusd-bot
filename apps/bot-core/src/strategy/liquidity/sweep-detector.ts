import { Candle } from '../../types/market.types';
import {
  LiquidityLevel,
  LiquiditySweep,
} from './liquidity.types';

export function detectLiquiditySweep(
  candles: Candle[],
  levels: LiquidityLevel[],
): LiquiditySweep | null {
  const current = candles[candles.length - 1];

  for (const level of levels) {
    // Sweep bajista (tomar buy-side liquidity)
    if (
      level.type === 'EQH' &&
      current.high > level.price &&
      current.close < level.price
    ) {
      const displacementStrength = current.high - current.close;

      return {
        level,
        clusterId: String(level.price),
        type: level.type,
        sweptAt: current.time,
        sweepPrice: level.price,
        candleTime: current.time,
        sweepCandleHigh: current.high,
        sweepCandleLow: current.low,
        direction: 'bearish',
        rejectionStrength: displacementStrength,
        displacementStrength,
      };
    }

    // Sweep alcista (tomar sell-side liquidity)
    if (
      level.type === 'EQL' &&
      current.low < level.price &&
      current.close > level.price
    ) {
      const displacementStrength = current.close - current.low;

      return {
        level,
        clusterId: String(level.price),
        type: level.type,
        sweptAt: current.time,
        sweepPrice: level.price,
        candleTime: current.time,
        sweepCandleHigh: current.high,
        sweepCandleLow: current.low,
        direction: 'bullish',
        rejectionStrength: displacementStrength,
        displacementStrength,
      };
    }
  }

  return null;
}