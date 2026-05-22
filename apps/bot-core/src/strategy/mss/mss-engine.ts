import { EventEmitter } from 'events';

import { MSSDetector } from './mss-detector';

export class MSSEngine extends EventEmitter {
  private readonly detector = new MSSDetector();

  analyzeBearishShift(
    candle: any,
    lastSwingLow: any,
  ) {
    const mss =
      this.detector.detectBearishMSS(
        candle,
        lastSwingLow,
      );

    if (mss) {
      this.emit('bearishMSS', mss);
    }
  }

  analyzeBullishShift(
    candle: any,
    lastSwingHigh: any,
  ) {
    const mss =
      this.detector.detectBullishMSS(
        candle,
        lastSwingHigh,
      );

    if (mss) {
      this.emit('bullishMSS', mss);
    }
  }
}