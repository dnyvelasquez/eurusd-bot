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
  private readonly partialTpDone = new Set<number>();

  constructor(
    private readonly beAtPoints: number = 0,
    private readonly beBuffer: number = 0,
    private readonly trailRr: number = 0,  // 0 = disabled; >0 = trail at trailRr × slDist behind price
  ) {}

  check(position: Position, currentPrice: number, partialTpEnabled = false): PositionAction | null {
    const slDistance = Math.abs(position.priceOpen - position.stopLoss);
    if (slDistance === 0) return null;

    const profitPoints =
      position.type === 'BUY'
        ? currentPrice - position.priceOpen
        : position.priceOpen - currentPrice;

    // Trailing stop: activates at trailRr × slDist profit, SL follows at trailRr × slDist behind price
    if (this.trailRr > 0 && profitPoints >= slDistance * this.trailRr) {
      const trailDist = slDistance * this.trailRr;
      const newSL =
        position.type === 'BUY'
          ? currentPrice - trailDist
          : currentPrice + trailDist;

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

    // Break-even: precio se movió ≥ beAtPoints → SL a entrada + beBuffer (0 = desactivado)
    if (this.beAtPoints > 0 && profitPoints >= this.beAtPoints) {
      const beSL =
        position.type === 'BUY'
          ? position.priceOpen + this.beBuffer
          : position.priceOpen - this.beBuffer;

      // Partial TP: cerrar 50% y mover SL a BE
      if (partialTpEnabled && !this.partialTpDone.has(position.ticket)) {
        this.partialTpDone.add(position.ticket);
        const half = Math.max(0.1, Math.round((position.volume / 2) * 10) / 10);
        return {
          ticket: position.ticket,
          symbol: position.symbol,
          newSL: beSL,
          keepTP: position.takeProfit,
          reason: 'PARTIAL_TP',
          partialVolume: half,
        };
      }

      // Full BE: mover SL solo si aún no está en BE
      if (!partialTpEnabled) {
        const alreadyBE =
          position.type === 'BUY'
            ? position.stopLoss >= beSL
            : position.stopLoss <= beSL;

        if (!alreadyBE) {
          return {
            ticket: position.ticket,
            symbol: position.symbol,
            newSL: beSL,
            keepTP: position.takeProfit,
            reason: 'BREAK_EVEN',
          };
        }
      }
    }

    return null;
  }

  clearTicket(ticket: number): void {
    this.partialTpDone.delete(ticket);
  }
}
