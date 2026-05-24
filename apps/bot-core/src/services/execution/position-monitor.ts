import { Position } from '../mt5/mt5.types';

export interface PositionAction {
  ticket: number;
  symbol: string;
  newSL: number;
  keepTP: number;
  reason: 'BREAK_EVEN' | 'TRAILING_STOP' | 'PARTIAL_TP';
  partialVolume?: number;
}

export class PositionMonitor {
  private readonly breakEvenAt = 1.0;
  private readonly trailAt = 2.0;
  private readonly partialTpDone = new Set<number>();

  check(position: Position, currentPrice: number, partialTpEnabled = false): PositionAction | null {
    const slDistance = Math.abs(position.priceOpen - position.stopLoss);

    if (slDistance === 0) return null;

    const profit =
      position.type === 'BUY'
        ? currentPrice - position.priceOpen
        : position.priceOpen - currentPrice;

    // Trailing stop: precio se movió ≥ 2R → arrastrar SL a 1R del precio actual
    if (profit >= slDistance * this.trailAt) {
      const newSL =
        position.type === 'BUY'
          ? currentPrice - slDistance
          : currentPrice + slDistance;

      const improves =
        position.type === 'BUY'
          ? newSL > position.stopLoss
          : newSL < position.stopLoss;

      if (improves) {
        return {
          ticket: position.ticket,
          symbol: position.symbol,
          newSL,
          keepTP: position.takeProfit,
          reason: 'TRAILING_STOP',
        };
      }
    }

    // Partial TP at 1R: cerrar 50% y mover SL a break-even
    if (partialTpEnabled && profit >= slDistance * this.breakEvenAt && !this.partialTpDone.has(position.ticket)) {
      this.partialTpDone.add(position.ticket);
      const half = Math.max(0.1, Math.round((position.volume / 2) * 10) / 10);
      return {
        ticket: position.ticket,
        symbol: position.symbol,
        newSL: position.priceOpen,
        keepTP: position.takeProfit,
        reason: 'PARTIAL_TP',
        partialVolume: half,
      };
    }

    // Break-even: precio se movió ≥ 1R → mover SL a precio de entrada
    if (!partialTpEnabled && profit >= slDistance * this.breakEvenAt) {
      const alreadyAtBE =
        position.type === 'BUY'
          ? position.stopLoss >= position.priceOpen
          : position.stopLoss <= position.priceOpen;

      if (!alreadyAtBE) {
        return {
          ticket: position.ticket,
          symbol: position.symbol,
          newSL: position.priceOpen,
          keepTP: position.takeProfit,
          reason: 'BREAK_EVEN',
        };
      }
    }

    return null;
  }

  clearTicket(ticket: number): void {
    this.partialTpDone.delete(ticket);
  }
}
