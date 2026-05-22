import { EventEmitter } from 'events';

import { EntryValidator } from './entry-validator';

import { TradeSetup } from './entry-types';

export class EntryEngine extends EventEmitter {
  private readonly validator =
    new EntryValidator();

  analyze(context: any) {
    const valid =
      this.validator.validate(
        context,
      );

    if (!valid) {
      return;
    }

    const setup: TradeSetup = {
      direction:
        context.mssDirection ===
        'BULLISH'
          ? 'BUY'
          : 'SELL',

      entryPrice: context.entryPrice,

      stopLoss: context.stopLoss,

      target: context.target,

      confidence: 0.9,

      reason: [
        'HTF Bias aligned',
        'Liquidity sweep confirmed',
        'MSS confirmed',
        'Displacement detected',
        'FVG detected',
      ],

      timestamp: Date.now(),
    };

    this.emit(
      'tradeSetup',
      setup,
    );
  }
}