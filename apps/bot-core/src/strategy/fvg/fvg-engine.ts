import { EventEmitter } from 'events';

import { DisplacementDetector } from './displacement-detector';
import { FVGDetector } from './fvg-detector';

export class FVGEngine extends EventEmitter {
  private readonly displacementDetector =
    new DisplacementDetector();

  private readonly fvgDetector =
    new FVGDetector();

  analyze(
    candles: any[],
  ) {
    const lastCandle =
      candles[candles.length - 1];

    const displacement =
      this.displacementDetector.detect(
        lastCandle,
      );

    if (displacement) {
      this.emit(
        'displacement',
        displacement,
      );
    }

    const bullishFVG =
      this.fvgDetector.detectBullish(
        candles.slice(-3),
      );

    if (bullishFVG) {
      this.emit(
        'bullishFVG',
        bullishFVG,
      );
    }

    const bearishFVG =
      this.fvgDetector.detectBearish(
        candles.slice(-3),
      );

    if (bearishFVG) {
      this.emit(
        'bearishFVG',
        bearishFVG,
      );
    }
  }
}