interface ValidationContext {
  htfBias: 'BULLISH' | 'BEARISH';

  sweepDirection:
    | 'BULLISH'
    | 'BEARISH';

  mssDirection:
    | 'BULLISH'
    | 'BEARISH';

  hasDisplacement: boolean;

  hasFVG: boolean;
}

export class EntryValidator {
  validate(
    context: ValidationContext,
  ): boolean {
    const biasAligned =
      context.htfBias ===
      context.mssDirection;

    const sweepAligned =
      context.sweepDirection ===
      context.mssDirection;

    return (
      biasAligned &&
      sweepAligned &&
      context.hasDisplacement &&
      context.hasFVG
    );
  }
}