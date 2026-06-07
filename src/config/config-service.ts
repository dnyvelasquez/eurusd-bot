import fs from 'fs';
import path from 'path';

import { logger } from '@infra/logger/logger';
import type { BlockedWindow } from '@infra/session/session-guard';

import { env } from './env';

const DEFAULT_BLOCKED_HOURS: BlockedWindow[] = [
  { from: '17:00', to: '03:00', label: 'Asian session (low liquidity)' },
];

interface BotConfig {
  SYMBOL: string;
  RISK_PERCENT: number;
  LIVE_TRADING: boolean;
  SIGNAL_COOLDOWN_MINUTES: number;
  TELEGRAM_ENABLED?: boolean;
  LICENSE_KEY?: string;
  BLOCKED_HOURS?: BlockedWindow[];
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
  EP_MAX_HOUR?: number;
  EP_ADX_PERIOD?: number;
  EP_ADX_MIN?: number;
  EP_H4_ALIGN?: boolean;
  EP_ADX_MAX?: number;
  MAX_CONSEC_LOSS_DAYS?: number;
  MAX_DAILY_LOSSES?: number;
  TRAIL_RR?: number;
  ZB_ENABLED?: boolean;
  CI_MAX?: number;
  CI_PERIOD?: number;
  CI_BUY_ONLY?: boolean;
  SMA_TREND_PERIOD?: number;
  SMA_TREND_TF?: 'D1' | 'H4' | 'H1';
  ENABLE_SMAX?: boolean;
  SMAX_FAST_PERIOD?: number;
  SMAX_SLOW_PERIOD?: number;
  SMAX_TF?: 'H1' | 'H4';
  SMAX_LOOKBACK?: number;
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
  get telegramEnabled(): boolean { return this.config.TELEGRAM_ENABLED ?? true; }
  get blockedHours(): BlockedWindow[] { return this.config.BLOCKED_HOURS?.length ? this.config.BLOCKED_HOURS : DEFAULT_BLOCKED_HOURS; }
  get maxDailyTrades(): number { return this.config.MAX_DAILY_TRADES ?? 0; }
  get minFvgPoints(): number { return this.config.MIN_FVG_POINTS ?? 0; }
  get minSlPoints(): number { return this.config.MIN_SL_POINTS ?? 0; }
  get partialTpEnabled(): boolean { return this.config.PARTIAL_TP_ENABLED ?? false; }
  get semiAutoMode(): boolean { return this.config.SEMI_AUTO_MODE ?? false; }
  get zoneProximityPoints(): number { return this.config.ZONE_PROXIMITY_POINTS ?? 20; }
  get zoneSlBufferPoints(): number { return this.config.ZONE_SL_BUFFER_POINTS ?? 5; }
  get beAtPoints(): number { return this.config.BE_AT_POINTS ?? 8; }
  get beBufferPoints(): number { return this.config.BE_BUFFER_POINTS ?? 0.25; }
  get trailRr(): number { return this.config.TRAIL_RR ?? 0; }
  get maxConsecLosses(): number { return this.config.MAX_CONSEC_LOSSES ?? 0; }
  get emaSpreadMin(): number { return this.config.EMA_SPREAD_MIN ?? 0; }
  get epM15Align(): boolean { return this.config.EP_M15_ALIGN ?? true; }
  get epSkipMonday(): boolean { return this.config.EP_SKIP_MONDAY ?? false; }
  get epMinHour(): number { return this.config.EP_MIN_HOUR ?? 0; }
  get epMaxHour(): number    { return this.config.EP_MAX_HOUR   ?? 0;  }
  get epAdxPeriod(): number  { return this.config.EP_ADX_PERIOD ?? 14;    }
  get epAdxMin(): number     { return this.config.EP_ADX_MIN    ?? 0;     }
  get epH4Align(): boolean   { return this.config.EP_H4_ALIGN   ?? false; }
  get epAdxMax(): number     { return this.config.EP_ADX_MAX    ?? 0;     }
  get maxConsecLossDays(): number { return this.config.MAX_CONSEC_LOSS_DAYS ?? 0; }
  get maxDailyLosses(): number { return this.config.MAX_DAILY_LOSSES ?? 0; }
  // Backtest parity (backtest-runner.ts): ZB gate + H4 choppiness filter
  get zbEnabled(): boolean { return this.config.ZB_ENABLED ?? true; }
  get ciMax(): number { return this.config.CI_MAX ?? 0; }
  get ciPeriod(): number { return this.config.CI_PERIOD ?? 14; }
  get ciBuyOnly(): boolean { return this.config.CI_BUY_ONLY ?? false; }
  get smaTrendPeriod(): number { return this.config.SMA_TREND_PERIOD ?? 0; }
  get smaTrendTf(): 'D1' | 'H4' | 'H1' { return this.config.SMA_TREND_TF ?? 'D1'; }
  get enableSmax(): boolean { return this.config.ENABLE_SMAX ?? false; }
  get smaxFastPeriod(): number { return this.config.SMAX_FAST_PERIOD ?? 20; }
  get smaxSlowPeriod(): number { return this.config.SMAX_SLOW_PERIOD ?? 50; }
  get smaxTf(): 'H1' | 'H4' { return this.config.SMAX_TF ?? 'H1'; }
  get smaxLookback(): number { return this.config.SMAX_LOOKBACK ?? 5; }

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
