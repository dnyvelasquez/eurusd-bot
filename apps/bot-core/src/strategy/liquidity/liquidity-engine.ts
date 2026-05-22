import { EventEmitter } from 'events';

import { LiquidityClustering } from './liquidity-clustering';
import { LiquiditySweepDetector } from './liquidity-sweep-detector';
import {
  LiquidityCluster,
  LiquidityLevel,
  LiquiditySweep,
} from './liquidity-types';

export class LiquidityEngine extends EventEmitter {
  private readonly clustering = new LiquidityClustering();

  private readonly sweepDetector = new LiquiditySweepDetector();

  private levels: LiquidityLevel[] = [];

  private clusters: LiquidityCluster[] = [];

  addLevels(levels: LiquidityLevel[]) {
    this.levels = levels;

    this.clusters = this.clustering.cluster(levels);

    this.emit('clustersUpdated', this.clusters);
  }

  analyzeCandle(candle: any) {
    const sweeps = this.sweepDetector.detect(
      this.clusters,
      candle,
    );

    for (const sweep of sweeps) {
      this.emit('liquiditySweep', sweep);
    }
  }

  getClusters() {
    return this.clusters;
  }
}