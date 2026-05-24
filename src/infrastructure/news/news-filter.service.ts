import axios from 'axios';

import { logger } from '@infra/logger/logger';

interface FFEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
}

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const BLOCK_WINDOW_MS = 60_000;

export class NewsFilterService {
  private events: FFEvent[] = [];
  private lastFetchDate = '';
  private refreshTimer: NodeJS.Timeout | null = null;

  async initialize(): Promise<void> {
    await this.refresh();
    this.scheduleDailyRefresh();
  }

  isBlocked(): boolean {
    const now = Date.now();
    return this.events.some((event) => {
      const eventTime = new Date(event.date).getTime();
      return Math.abs(now - eventTime) <= BLOCK_WINDOW_MS;
    });
  }

  nextBlockedEvent(): { title: string; date: Date } | null {
    const now = Date.now();
    const upcoming = this.events
      .map((e) => ({ title: e.title, date: new Date(e.date) }))
      .filter((e) => e.date.getTime() > now)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    return upcoming[0] ?? null;
  }

  stop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refresh(attempt = 1): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastFetchDate === today && this.events.length > 0) return;

    try {
      const raw = await this.fetchCalendar();
      this.events = raw.filter((e) => e.country === 'USD' && e.impact === 'High');
      this.lastFetchDate = today;
      logger.info({ count: this.events.length }, 'News calendar refreshed — USD high-impact events loaded');
    } catch (err) {
      const retryDelays = [5 * 60_000, 30 * 60_000]; // 5 min, 30 min
      const delay = retryDelays[attempt - 1];

      if (delay) {
        logger.warn(
          { attempt, retryInMs: delay },
          'News calendar fetch failed — will retry',
        );
        setTimeout(() => this.refresh(attempt + 1), delay);
      } else {
        logger.warn(err, 'News calendar fetch failed after all retries — filter disabled for today');
      }
    }
  }

  private async fetchCalendar(): Promise<FFEvent[]> {
    const { data } = await axios.get<FFEvent[]>(CALENDAR_URL, {
      timeout: 10_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.forexfactory.com/',
      },
    });
    return data;
  }

  private scheduleDailyRefresh(): void {
    const now = new Date();
    const nextMidnightUTC = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const msUntilMidnight = nextMidnightUTC - Date.now();

    this.refreshTimer = setTimeout(async () => {
      this.lastFetchDate = '';
      await this.refresh();
      this.scheduleDailyRefresh();
    }, msUntilMidnight);
  }
}
