import fs from 'fs';
import path from 'path';

import { logger } from '@infra/logger/logger';
import type { BlockedWindow } from '@infra/session/session-guard';

import { env } from './env';

const DEFAULT_BLOCKED_HOURS: BlockedWindow[] = [
  { from: '09:30', to: '09:35', label: 'NY Open' },
  { from: '12:00', to: '13:00', label: 'NY Lunch' },
  { from: '15:45', to: '16:00', label: 'NY Close' },
  { from: '16:00', to: '09:30', label: 'Out of market' },
];

interface BotConfig {
  SYMBOL: string;
  RISK_PERCENT: number;
  LIVE_TRADING: boolean;
  SIGNAL_COOLDOWN_MINUTES: number;
  MAX_DAILY_DRAWDOWN_PERCENT?: number;
  TELEGRAM_ENABLED?: boolean;
  LICENSE_KEY?: string;
  BLOCKED_HOURS?: BlockedWindow[];
  MAX_DAILY_PROFIT_PERCENT?: number;
  MAX_WEEKLY_DRAWDOWN_PERCENT?: number;
  MAX_DAILY_TRADES?: number;
  MIN_FVG_POINTS?: number;
  PARTIAL_TP_ENABLED?: boolean;
  M15_CONFIRMATION_ENABLED?: boolean;
  SEMI_AUTO_MODE?: boolean;
}

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');

class ConfigService {
  private config: BotConfig;
  private watcher: fs.FSWatcher | null = null;

  constructor() {
    this.config = this.loadFile() ?? this.fromEnv();
    this.startWatcher();
  }

  get symbol(): string { return this.config.SYMBOL; }
  get riskPercent(): number { return this.config.RISK_PERCENT; }
  get liveTrading(): boolean { return this.config.LIVE_TRADING; }
  get signalCooldownMinutes(): number { return this.config.SIGNAL_COOLDOWN_MINUTES; }
  get maxDailyDrawdownPercent(): number { return this.config.MAX_DAILY_DRAWDOWN_PERCENT ?? 3; }
  get telegramEnabled(): boolean { return this.config.TELEGRAM_ENABLED ?? true; }
  get blockedHours(): BlockedWindow[] { return this.config.BLOCKED_HOURS ?? DEFAULT_BLOCKED_HOURS; }
  get maxDailyProfitPercent(): number { return this.config.MAX_DAILY_PROFIT_PERCENT ?? 3; }
  get maxWeeklyDrawdownPercent(): number { return this.config.MAX_WEEKLY_DRAWDOWN_PERCENT ?? 5; }
  get maxDailyTrades(): number { return this.config.MAX_DAILY_TRADES ?? 0; }
  get minFvgPoints(): number { return this.config.MIN_FVG_POINTS ?? 0; }
  get partialTpEnabled(): boolean { return this.config.PARTIAL_TP_ENABLED ?? false; }
  get m15ConfirmationEnabled(): boolean { return this.config.M15_CONFIRMATION_ENABLED ?? false; }
  get semiAutoMode(): boolean { return this.config.SEMI_AUTO_MODE ?? false; }

  // LICENSE_KEY: config.json tiene prioridad sobre .env
  get licenseKey(): string | undefined {
    const fromFile = this.config.LICENSE_KEY;
    return fromFile && fromFile.length > 0 ? fromFile : env.LICENSE_KEY;
  }

  private loadFile(): BotConfig | null {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as BotConfig;
    } catch {
      return null;
    }
  }

  private fromEnv(): BotConfig {
    return {
      SYMBOL: env.SYMBOL,
      RISK_PERCENT: env.RISK_PERCENT,
      LIVE_TRADING: env.LIVE_TRADING,
      SIGNAL_COOLDOWN_MINUTES: env.SIGNAL_COOLDOWN_MINUTES,
    };
  }

  private startWatcher(): void {
    if (!fs.existsSync(CONFIG_PATH)) return;

    let debounce: NodeJS.Timeout | null = null;

    this.watcher = fs.watch(CONFIG_PATH, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const loaded = this.loadFile();
        if (loaded) {
          this.config = loaded;
          logger.info(
            { symbol: loaded.SYMBOL, risk: loaded.RISK_PERCENT, live: loaded.LIVE_TRADING },
            'Config reloaded from config.json',
          );
        }
      }, 200);
    });
  }

  public stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

export const configService = new ConfigService();
