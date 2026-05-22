import {
  PositionSizingResult,
  RiskParameters,
} from './risk-types';

export class PositionSizing {
  calculate(
    params: RiskParameters,
  ): PositionSizingResult {
    const riskAmount =
      params.accountBalance *
      (params.riskPercent / 100);

    const stopDistance =
      Math.abs(
        params.entryPrice -
          params.stopLoss,
      );

    const targetDistance =
      Math.abs(
        params.target -
          params.entryPrice,
      );

    const riskRewardRatio =
      targetDistance / stopDistance;

    const positionSize =
      riskAmount / stopDistance;

    return {
      riskAmount,

      stopDistance,

      positionSize,

      riskRewardRatio,
    };
  }
}