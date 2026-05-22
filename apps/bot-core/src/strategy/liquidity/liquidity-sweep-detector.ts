import {
  LiquidityCluster,
  LiquiditySweep,
} from './liquidity-types';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class LiquiditySweepDetector {
  detect(
    clusters: LiquidityCluster[],
    candle: Candle,
  ): LiquiditySweep[] {
    const sweeps: LiquiditySweep[] = [];

    for (const cluster of clusters) {
      if (cluster.type === 'EQH') {
        const swept =
          candle.high > cluster.averagePrice &&
          candle.close < cluster.averagePrice;

        if (swept) {
          sweeps.push({
            clusterId: cluster.id,
            type: cluster.type,
            sweepPrice: candle.high,
            candleTime: candle.time,
            rejectionStrength:
              candle.high - Math.max(candle.open, candle.close),
          });
        }
      }

      if (cluster.type === 'EQL') {
        const swept =
          candle.low < cluster.averagePrice &&
          candle.close > cluster.averagePrice;

        if (swept) {
          sweeps.push({
            clusterId: cluster.id,
            type: cluster.type,
            sweepPrice: candle.low,
            candleTime: candle.time,
            rejectionStrength:
              Math.min(candle.open, candle.close) - candle.low,
          });
        }
      }
    }

    return sweeps;
  }
}