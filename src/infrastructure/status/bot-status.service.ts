import fs from 'fs';
import path from 'path';

export interface BotStatusMetrics {
  dailyDrawdownPct: number;
  dailyProfitPct: number;
  weeklyDrawdownPct: number;
  maxDailyDrawdown: number;
  maxDailyProfit: number;
  maxWeeklyDrawdown: number;
}

export interface BotStatus {
  ready: boolean;
  reason: string | null;
  updatedAt: string;
  metrics: BotStatusMetrics;
}

const STATUS_PATH = path.resolve(__dirname, '..', '..', '..', 'bot-status.json');

export class BotStatusService {
  write(status: BotStatus): void {
    try {
      fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
    } catch { /* no bloquear el ciclo */ }
  }
}
