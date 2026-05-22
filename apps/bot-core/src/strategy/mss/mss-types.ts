export type MSSDirection = 'BULLISH' | 'BEARISH';

export interface MSS {
  direction: MSSDirection;

  brokenPrice: number;

  breakTime: number;

  displacementStrength: number;

  referenceSwingTime: number;
}