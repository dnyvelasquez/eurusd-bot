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
  MIN_SL_POINTS?: number;
  PARTIAL_TP_ENABLED?: boolean;
  SEMI_AUTO_MODE?: boolean;
  ZONE_PROXIMITY_POINTS?: number;
  ZONE_SL_BUFFER_POINTS?: number;
  BE_AT_POINTS?: number;
  BE_BUFFER_POINTS?: number;
  MAX_CONSEC_LOSSES?: number;
  EMA_SPREAD_MIN?: number;
  EP_M15_ALIGN?: boolean;
  EP_SKIP_MONDAY?: boolean;
  EP_MIN_HOUR?: number;
  MAX_CONSEC_LOSS_DAYS?: number;
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
  get maxDailyTrades(): number { return this.config.MAX_DAILY_TRADES ?? 0; }
  get minFvgPoints(): number { return this.config.MIN_FVG_POINTS ?? 0; }
  get minSlPoints(): number { return this.config.MIN_SL_POINTS ?? 0; }
  get partialTpEnabled(): boolean { return this.config.PARTIAL_TP_ENABLED ?? false; }
  get semiAutoMode(): boolean { return this.config.SEMI_AUTO_MODE ?? false; }
  get zoneProximityPoints(): number { return this.config.ZONE_PROXIMITY_POINTS ?? 20; }
  get zoneSlBufferPoints(): number { return this.config.ZONE_SL_BUFFER_POINTS ?? 5; }
  get beAtPoints(): number { return this.config.BE_AT_POINTS ?? 8; }
  get beBufferPoints(): number { return this.config.BE_BUFFER_POINTS ?? 0.25; }
  get maxConsecLosses(): number { return this.config.MAX_CONSEC_LOSSES ?? 0; }
  get emaSpreadMin(): number { return this.config.EMA_SPREAD_MIN ?? 0; }
  get epM15Align(): boolean { return this.config.EP_M15_ALIGN ?? true; }
  get epSkipMonday(): boolean { return this.config.EP_SKIP_MONDAY ?? false; }
  get epMinHour(): number { return this.config.EP_MIN_HOUR ?? 0; }
  get maxConsecLossDays(): number { return this.config.MAX_CONSEC_LOSS_DAYS ?? 0; }

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
