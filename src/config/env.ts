import dotenv from 'dotenv';

import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),

  TELEGRAM_BOT_TOKEN: z.string().min(1),

  SYMBOL: z.string().default('SPX500'),

  // Porcentaje del balance a arriesgar por operación (ej: 1 = 1%)
  RISK_PERCENT: z.coerce.number().min(0.1).max(10).default(1),

  // En false el bot loggea el setup pero NO envía la orden a MT5
  LIVE_TRADING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Minutos de espera entre señales del mismo tipo (BULLISH o BEARISH)
  SIGNAL_COOLDOWN_MINUTES: z.coerce.number().min(1).default(30),

  // Chat ID de Telegram donde enviar notificaciones (opcional)
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Neon (PostgreSQL) — validación de licencia (opcional en desarrollo)
  DATABASE_URL: z.string().url().optional(),
  LICENSE_KEY: z.string().uuid().optional(),
});

export const env = envSchema.parse(process.env);