export interface RiskParameters {
  accountBalance: number;

  riskPercent: number;

  entryPrice: number;

  stopLoss: number;

  target: number;

  tradeTickSize: number;

  tradeTickValue: number;
}

export interface PositionSizingResult {
  riskAmount: number;

  stopDistance: number;

  positionSize: number;

  riskRewardRatio: number;
}