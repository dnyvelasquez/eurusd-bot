import { describe, it, expect } from 'vitest';
import { PositionMonitor } from '../../apps/bot-core/src/services/execution/position-monitor';

// Valores enteros como "puntos" abstractos: PositionMonitor es agnóstico a la escala
// de precio, así se evita la fragilidad de punto flotante de los decimales de EURUSD.
const buyPosition = {
  ticket: 1,
  symbol: 'EURUSD',
  type: 'BUY' as const,
  volume: 0.01,
  priceOpen: 5000,
  stopLoss: 4990,   // SL 10 puntos abajo → slDist = 10
  takeProfit: 5020,
  profit: 0,
};

const sellPosition = {
  ...buyPosition,
  type: 'SELL' as const,
  stopLoss: 5010,  // SL 10 puntos arriba
};

describe('PositionMonitor', () => {
  // beAtPoints=10 (BE al moverse 10 pts a favor), trailRr=0 (trailing desactivado)
  const beMonitor = new PositionMonitor(10, 0, 0);
  // trailRr=1 (trailing activa y sigue a 1×slDist), beAtPoints=0 (BE desactivado)
  const trailMonitor = new PositionMonitor(0, 0, 1);

  describe('BUY — break-even', () => {
    it('activa break-even cuando el precio se mueve beAtPoints a favor', () => {
      const action = beMonitor.check(buyPosition, 5010); // +10 pts
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('BREAK_EVEN');
      expect(action!.newSL).toBe(5000);
    });

    it('no activa break-even si SL ya está en entrada', () => {
      const action = beMonitor.check({ ...buyPosition, stopLoss: 5000 }, 5010);
      expect(action).toBeNull();
    });

    it('no activa nada si el precio no llegó al trigger', () => {
      const action = beMonitor.check(buyPosition, 5005); // solo +5 pts
      expect(action).toBeNull();
    });
  });

  describe('BUY — trailing stop', () => {
    it('activa trailing cuando el precio supera trailRr × slDist', () => {
      const action = trailMonitor.check(buyPosition, 5020); // +20 pts ≥ 10
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('TRAILING_STOP');
      expect(action!.newSL).toBe(5010); // precio actual - trailRr × slDist
    });

    it('no mueve el trailing si no mejora el SL actual', () => {
      const positionWithHighSL = { ...buyPosition, stopLoss: 5015 };
      const action = trailMonitor.check(positionWithHighSL, 5020);
      expect(action).toBeNull();
    });
  });

  describe('SELL — break-even', () => {
    it('activa break-even cuando el precio baja beAtPoints', () => {
      const action = beMonitor.check(sellPosition, 4990); // -10 pts
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('BREAK_EVEN');
      expect(action!.newSL).toBe(5000);
    });
  });

  describe('SELL — trailing stop', () => {
    it('activa trailing cuando el precio baja trailRr × slDist', () => {
      const action = trailMonitor.check(sellPosition, 4980); // -20 pts ≥ 10
      expect(action).not.toBeNull();
      expect(action!.reason).toBe('TRAILING_STOP');
      expect(action!.newSL).toBe(4990); // precio actual + trailRr × slDist
    });
  });
});
