import { ExecutionOrder } from './execution-types';

export class ExecutionValidator {
  validate(
    order: ExecutionOrder,
  ): boolean {
    const validVolume =
      order.volume > 0;

    const validSL =
      order.side === 'BUY'
        ? order.stopLoss <
          order.entryPrice
        : order.stopLoss >
          order.entryPrice;

    const validTP =
      order.side === 'BUY'
        ? order.takeProfit >
          order.entryPrice
        : order.takeProfit <
          order.entryPrice;

    return (
      validVolume &&
      validSL &&
      validTP
    );
  }
}