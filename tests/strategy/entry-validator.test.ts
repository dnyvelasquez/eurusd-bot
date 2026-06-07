import { describe, it, expect } from 'vitest';
import { EntryValidator } from '../../apps/bot-core/src/strategy/entry/entry-validator';

describe('EntryValidator', () => {
  const validator = new EntryValidator();

  const validBullish = {
    htfBias: 'BULLISH' as const,
    m15Momentum: 'BULLISH' as const,
    hasDisplacement: true,
    hasFVG: true,
  };

  it('aprueba un setup bullish con todas las condiciones', () => {
    expect(validator.validate(validBullish)).toBe(true);
  });

  it('rechaza cuando el sesgo HTF no está alineado con el momentum M15', () => {
    expect(validator.validate({ ...validBullish, htfBias: 'BEARISH' })).toBe(false);
  });

  it('rechaza cuando el momentum M15 no coincide con el sesgo HTF', () => {
    expect(validator.validate({ ...validBullish, m15Momentum: 'BEARISH' })).toBe(false);
  });

  it('rechaza cuando no hay desplazamiento', () => {
    expect(validator.validate({ ...validBullish, hasDisplacement: false })).toBe(false);
  });

  it('rechaza cuando no hay FVG', () => {
    expect(validator.validate({ ...validBullish, hasFVG: false })).toBe(false);
  });

  it('aprueba un setup bearish válido', () => {
    expect(validator.validate({
      htfBias: 'BEARISH',
      m15Momentum: 'BEARISH',
      hasDisplacement: true,
      hasFVG: true,
    })).toBe(true);
  });
});
