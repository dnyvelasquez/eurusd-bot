export type LiquidityType = 'EQH' | 'EQL';

export interface LiquidityLevel {
  price: number;
  type: LiquidityType;
  touches: number;
  firstTouchTime: number;
}

export interface LiquidityCluster {
  id: string;
  type: LiquidityType;
  averagePrice: number;
  levels: LiquidityLevel[];
  strength: number;
  createdAt: number;
}

export interface LiquiditySweep {
  clusterId: string;
  type: LiquidityType;
  sweepPrice: number;
  candleTime: number;
  rejectionStrength: number;
}