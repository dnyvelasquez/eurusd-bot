import { logger } from '@infra/logger/logger';

export class WeeklyDrawdownGuard {
  private referenceBalance: number | null = null;
  private referenceWeek = '';

  setReference(balance: number): void {
    const week = this.currentWeekStart();
    if (this.referenceWeek === week) return;

    this.referenceBalance = balance;
    this.referenceWeek = week;
    logger.info({ balance, week }, 'Weekly drawdown reference set');
  }

  isBreached(currentBalance: number, maxDrawdownPercent: number): boolean {
    if (this.referenceBalance === null) return false;
    return this.drawdownPct(currentBalance) >= maxDrawdownPercent;
  }

  drawdownPct(currentBalance: number): number {
    if (this.referenceBalance === null) return 0;
    return ((this.referenceBalance - currentBalance) / this.referenceBalance) * 100;
  }

  // Devuelve el lunes de la semana actual en formato YYYY-MM-DD (UTC)
  private currentWeekStart(): string {
    const d = new Date();
    const day = d.getUTCDay() || 7; // domingo=7
    d.setUTCDate(d.getUTCDate() - day + 1);
    return d.toISOString().slice(0, 10);
  }
}
