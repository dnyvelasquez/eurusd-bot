import { PositionSizing } from './position-sizing';

export class RiskManager {
  private readonly sizing =
    new PositionSizing();

  validateSetup(params: any) {
    const result =
      this.sizing.calculate(params);

    const minimumRR = 2;

    const validRR =
      result.riskRewardRatio >=
      minimumRR;

    return {
      valid: validRR,

      metrics: result,
    };
  }
}