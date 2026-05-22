import { EventEmitter } from 'events';

import { MT5Executor } from './mt5-executor';

import { ExecutionValidator } from './execution-validator';

export class ExecutionEngine extends EventEmitter {
  private readonly validator =
    new ExecutionValidator();

  private readonly executor =
    new MT5Executor();

  async execute(order: any) {
    const valid =
      this.validator.validate(
        order,
      );

    if (!valid) {
      this.emit(
        'executionRejected',
        order,
      );

      return;
    }

    const result =
      await this.executor.execute(
        order,
      );

    if (result.success) {
      this.emit(
        'positionOpened',
        result,
      );
    } else {
      this.emit(
        'executionFailed',
        result,
      );
    }
  }
}