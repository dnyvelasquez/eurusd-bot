import https from 'https';

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

  private async refresh(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastFetchDate === today && this.events.length > 0) return;

    try {
      const raw = await this.fetchCalendar();
      this.events = raw.filter((e) => e.country === 'USD' && e.impact === 'High');
      this.lastFetchDate = today;
      logger.info({ count: this.events.length }, 'News calendar refreshed — USD high-impact events loaded');
    } catch (err) {
      logger.warn(err, 'Failed to fetch news calendar — news filter disabled for this cycle');
    }
  }

  private fetchCalendar(): Promise<FFEvent[]> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        CALENDAR_URL,
        { headers: { 'User-Agent': 'SPX500-Bot/1.0' } },
        (res) => {
          let body = '';
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(body) as FFEvent[]); }
            catch (e) { reject(e); }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10_000, () => {
        req.destroy(new Error('News calendar fetch timed out'));
      });
    });
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
