import fs from 'fs';
import path from 'path';

import postgres from 'postgres';

import { logger } from '@infra/logger/logger';
import { env } from '@config/env';
import { configService } from '@config/config-service';

export interface LicenseRecord {
  owner_name: string;
  mt5_account: number;
  allowed_mode: 'demo' | 'live' | 'both';
  active: boolean;
  expires_at: string | null;
}

const CACHE_PATH = path.resolve(__dirname, '..', '..', '..', 'license-cache.json');

export class LicenseService {
  async validate(mt5Login: number, tradeMode: 'DEMO' | 'CONTEST' | 'REAL'): Promise<void> {
    const licenseKey = configService.licenseKey;

    if (!env.DATABASE_URL || !licenseKey) {
      logger.warn('License validation skipped — DATABASE_URL / LICENSE_KEY not configured');
      return;
    }

    logger.info({ login: mt5Login }, 'Validating license...');

    const sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 1, connect_timeout: 5 });

    try {
      const rows = await sql<LicenseRecord[]>`
        SELECT owner_name, mt5_account, allowed_mode, active, expires_at
        FROM licenses
        WHERE license_key = ${licenseKey}::uuid
        LIMIT 1
      `;

      if (!rows.length) throw new Error('License key not found');

      const license = rows[0];

      if (!license.active) throw new Error('License is inactive — contact the administrator');

      if (license.expires_at && new Date(license.expires_at) < new Date()) {
        throw new Error(`License expired on ${license.expires_at}`);
      }

      if (Number(license.mt5_account) !== mt5Login) {
        throw new Error(
          `Account mismatch — license is for ${license.mt5_account}, connected account is ${mt5Login}`,
        );
      }

      this.validateMode(license.allowed_mode, tradeMode);

      logger.info(
        { owner: license.owner_name, login: mt5Login, mode: license.allowed_mode },
        'License valid',
      );

      this.writeCache(license, mt5Login, tradeMode);
    } catch (err: unknown) {
      if (this.isConnectionError(err)) {
        logger.warn({ err }, 'DB unreachable — falling back to license cache');
        this.validateFromCache(mt5Login, tradeMode);
        return;
      }
      throw err;
    } finally {
      await sql.end({ timeout: 3 });
    }
  }

  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('connect') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound')
    );
  }

  private validateFromCache(mt5Login: number, tradeMode: 'DEMO' | 'CONTEST' | 'REAL'): void {
    if (!fs.existsSync(CACHE_PATH)) {
      throw new Error('License DB unreachable and no local cache found — validate once when DB is available');
    }

    let cached: LicenseRecord & { mt5_account: number; validated_at: string };
    try {
      cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    } catch {
      throw new Error('License cache is corrupted and DB is unreachable');
    }

    if (!cached.active) throw new Error('License is inactive — contact the administrator');

    if (cached.expires_at && new Date(cached.expires_at) < new Date()) {
      throw new Error(`License expired on ${cached.expires_at}`);
    }

    if (Number(cached.mt5_account) !== mt5Login) {
      throw new Error(
        `Account mismatch — license is for ${cached.mt5_account}, connected account is ${mt5Login}`,
      );
    }

    this.validateMode(cached.allowed_mode, tradeMode);

    logger.warn(
      { owner: cached.owner_name, login: mt5Login, mode: cached.allowed_mode, cachedAt: cached.validated_at },
      'License validated from cache (DB temporarily unreachable)',
    );
  }

  private writeCache(license: LicenseRecord, mt5Login: number, tradeMode: string): void {
    try {
      fs.writeFileSync(
        CACHE_PATH,
        JSON.stringify(
          {
            owner_name: license.owner_name,
            mt5_account: mt5Login,
            trade_mode: tradeMode,
            allowed_mode: license.allowed_mode,
            active: license.active,
            expires_at: license.expires_at,
            validated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // no bloquear el arranque si falla la escritura
    }
  }

  private validateMode(allowed: 'demo' | 'live' | 'both', tradeMode: 'DEMO' | 'CONTEST' | 'REAL'): void {
    if (allowed === 'both') return;
    const isDemo = tradeMode === 'DEMO' || tradeMode === 'CONTEST';
    if (allowed === 'demo' && !isDemo) throw new Error('This license only allows demo accounts');
    if (allowed === 'live' && isDemo) throw new Error('This license only allows live accounts');
  }
}
