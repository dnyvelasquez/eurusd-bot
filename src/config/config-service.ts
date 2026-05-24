import fs from 'fs';
import path from 'path';

import { logger } from '@infra/logger/logger';

import { env } from './env';

interface BotConfig {
  SYMBOL: string;
  RISK_PERCENT: number;
  LIVE_TRADING: boolean;
  SIGNAL_COOLDOWN_MINUTES: number;
  LICENSE_KEY?: string;
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
