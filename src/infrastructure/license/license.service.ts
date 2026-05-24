import postgres from 'postgres';

import { logger } from '@infra/logger/logger';
import { env } from '@config/env';

export interface LicenseRecord {
  owner_name: string;
  mt5_account: number;
  allowed_mode: 'demo' | 'live' | 'both';
  active: boolean;
  expires_at: string | null;
}

export class LicenseService {
  private readonly configured: boolean;

  constructor() {
    this.configured = !!(env.DATABASE_URL && env.LICENSE_KEY);
  }

  /**
   * Valida la licencia contra Neon (PostgreSQL).
   * Si DATABASE_URL / LICENSE_KEY no están en el .env, omite la validación (modo dev).
   */
  async validate(mt5Login: number, tradeMode: 'DEMO' | 'CONTEST' | 'REAL'): Promise<void> {
    if (!this.configured) {
      logger.warn('License validation skipped — DATABASE_URL / LICENSE_KEY not set');
      return;
    }

    logger.info({ login: mt5Login }, 'Validating license...');

    const sql = postgres(env.DATABASE_URL!, { ssl: 'require', max: 1 });

    try {
      const rows = await sql<LicenseRecord[]>`
        SELECT owner_name, mt5_account, allowed_mode, active, expires_at
        FROM licenses
        WHERE license_key = ${env.LICENSE_KEY!}::uuid
        LIMIT 1
      `;

      if (!rows.length) {
        throw new Error('License key not found');
      }

      const license = rows[0];

      if (!license.active) {
        throw new Error('License is inactive — contact the administrator');
      }

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
    } finally {
      await sql.end();
    }
  }

  private validateMode(
    allowed: 'demo' | 'live' | 'both',
    tradeMode: 'DEMO' | 'CONTEST' | 'REAL',
  ): void {
    if (allowed === 'both') return;

    const isDemo = tradeMode === 'DEMO' || tradeMode === 'CONTEST';

    if (allowed === 'demo' && !isDemo) {
      throw new Error('This license only allows demo accounts — live trading is not permitted');
    }

    if (allowed === 'live' && isDemo) {
      throw new Error('This license only allows live accounts');
    }
  }
}
