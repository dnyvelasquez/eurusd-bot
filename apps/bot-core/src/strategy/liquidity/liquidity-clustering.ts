import { LiquidityCluster, LiquidityLevel } from './liquidity-types';
import { randomUUID } from 'crypto';

export class LiquidityClustering {
  private readonly maxDistancePoints: number;

  constructor(maxDistancePoints = 3) {
    this.maxDistancePoints = maxDistancePoints;
  }

  cluster(levels: LiquidityLevel[]): LiquidityCluster[] {
    if (!levels.length) {
      return [];
    }

    const sorted = [...levels].sort((a, b) => a.price - b.price);

    const clusters: LiquidityCluster[] = [];

    let currentCluster: LiquidityLevel[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const previous = sorted[i - 1];

      const distance = Math.abs(current.price - previous.price);

      if (distance <= this.maxDistancePoints) {
        currentCluster.push(current);
      } else {
        clusters.push(this.buildCluster(currentCluster));
        currentCluster = [current];
      }
    }

    clusters.push(this.buildCluster(currentCluster));

    return clusters;
  }

  private buildCluster(levels: LiquidityLevel[]): LiquidityCluster {
    const averagePrice =
      levels.reduce((sum, level) => sum + level.price, 0) / levels.length;

    const strength = levels.reduce(
      (sum, level) => sum + level.touches,
      0,
    );

    return {
      id: randomUUID(),
      type: levels[0].type,
      averagePrice,
      levels,
      strength,
      createdAt: Date.now(),
    };
  }
}