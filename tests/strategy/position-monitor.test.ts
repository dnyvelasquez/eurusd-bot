import { describe, it, expect } from 'vitest';
import { PositionMonitor } from '../../apps/bot-core/src/services/execution/position-monitor';

const buyPosition = {
  ticket: 1,
  symbol: 'EURUSD',
  type: 'BUY' as const,
  volume: 0.01,
  priceOpen: 5000,
  stopLoss: 4990,   // SL 10 puntos abajo → 1R = 10 puntos
  takeProfit: 5020,
  profit: 0,
};

const sellPosition = {
  ...buyPosition,
  type: 'SELL' as const,
  stopLoss: 5010,  // SL 10 puntos arriba
};

describe('PositionMonitor', () => {
  const monitor = new PositionMonitor();

  describe('BUY — break-even', () => {
    it('activa break-even cuando el precio se mueve 1R a favor', () => {
      const action = monitor.check(buyPosition, 5010); // +10 pts = 1R
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('BREAK_EVEN');
      expect(action!.newSL).toBe(5000);
    });

    it('no activa break-even si SL ya está en entrada', () => {
      const action = monitor.check({ ...buyPosition, stopLoss: 5000 }, 5010);
      expect(action).toBeNull();
    });

    it('no activa nada si el precio no llegó a 1R', () => {
      const action = monitor.check(buyPosition, 5005); // solo +5 pts
      expect(action).toBeNull();
    });
  });

  describe('BUY — trailing stop', () => {
    it('activa trailing cuando el precio se mueve 2R a favor', () => {
      const action = monitor.check(buyPosition, 5020); // +20 pts = 2R
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('TRAILING_STOP');
      expect(action!.newSL).toBe(5010); // precio actual - 1R
    });

    it('no mueve el trailing si no mejora el SL actual', () => {
      const positionWithHighSL = { ...buyPosition, stopLoss: 5015 };
      const action = monitor.check(positionWithHighSL, 5020);
      expect(action).toBeNull();
    });
  });

  describe('SELL — break-even', () => {
    it('activa break-even cuando el precio baja 1R', () => {
      const action = monitor.check(sellPosition, 4990); // -10 pts = 1R
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('BREAK_EVEN');
      expect(action!.newSL).toBe(5000);
    });
  });

  describe('SELL — trailing stop', () => {
    it('activa trailing cuando el precio baja 2R', () => {
      const action = monitor.check(sellPosition, 4980); // -20 pts = 2R
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('TRAILING_STOP');
      expect(action!.newSL).toBe(4990); // precio actual + 1R
    });
  });
});
