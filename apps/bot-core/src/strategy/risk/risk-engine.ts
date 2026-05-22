import { EventEmitter } from 'events';

import { RiskManager } from './risk-manager';

export class RiskEngine extends EventEmitter {
  private readonly manager =
    new RiskManager();

  analyze(params: any) {
    const result =
      this.manager.validateSetup(
        params,
      );

    if (!result.valid) {
      this.emit(
        'setupRejected',
        result,
      );

      return;
    }

    this.emit(
      'riskApproved',
      result,
    );
  }
}