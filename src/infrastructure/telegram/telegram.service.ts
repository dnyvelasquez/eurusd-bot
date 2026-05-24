import TelegramBot from 'node-telegram-bot-api';

import { env } from '@config/env';
import { configService } from '@config/config-service';
import { logger } from '@infra/logger/logger';

export class TelegramService {
  private readonly bot: TelegramBot;

  constructor() {
    this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: false });
  }

  public async initialize(): Promise<void> {
    logger.info('Initializing Telegram service...');
    const botInfo = await this.bot.getMe();
    logger.info(`Telegram bot connected: ${botInfo.username}`);

    if (!env.TELEGRAM_CHAT_ID) {
      logger.warn('TELEGRAM_CHAT_ID not set — notifications disabled');
    }
  }

  private async send(html: string): Promise<void> {
    if (!env.TELEGRAM_CHAT_ID) return;
    if (!configService.telegramEnabled) return;

    try {
      await this.bot.sendMessage(env.TELEGRAM_CHAT_ID, html, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.warn(err, 'Telegram send failed');
    }
  }

  async notifyStartup(symbol: string, riskPercent: number, liveTrading: boolean): Promise<void> {
    const mode = liveTrading ? 'LIVE 🔴' : 'PAPER 🟡';

    await this.send(
      `🤖 <b>SPX500 Bot iniciado</b>\n` +
      `Símbolo: <code>${symbol}</code> | Riesgo: ${riskPercent}% | ${mode}`,
    );
  }

  async notifyPaperSetup(params: {
    side: string;
    symbol: string;
    entry: number;
    sl: number;
    tp: number;
    volume: number;
    rr: string;
    riskAmount: string;
  }): Promise<void> {
    const { side, symbol, entry, sl, tp, volume, rr, riskAmount } = params;

    await this.send(
      `📋 <b>[PAPER] Setup validado — ${side} ${symbol}</b>\n\n` +
      `Entry:  <code>${entry.toFixed(2)}</code>\n` +
      `SL:     <code>${sl.toFixed(2)}</code>\n` +
      `TP:     <code>${tp.toFixed(2)}</code>\n\n` +
      `Vol: ${volume} | R:R: ${rr} | Riesgo: $${riskAmount}`,
    );
  }

  async notifyOrderPlaced(params: {
    orderId: number | undefined;
    side: string;
    symbol: string;
    entry: number;
    sl: number;
    tp: number;
    volume: number;
    rr: string;
    riskAmount: string;
  }): Promise<void> {
    const { orderId, side, symbol, entry, sl, tp, volume, rr, riskAmount } = params;

    await this.send(
      `✅ <b>Orden ejecutada — ${side} ${symbol}</b>\n` +
      `ID: <code>${orderId ?? 'N/A'}</code>\n\n` +
      `Entry:  <code>${entry.toFixed(2)}</code>\n` +
      `SL:     <code>${sl.toFixed(2)}</code>\n` +
      `TP:     <code>${tp.toFixed(2)}</code>\n\n` +
      `Vol: ${volume} | R:R: ${rr} | Riesgo: $${riskAmount}`,
    );
  }

  async notifyOrderFailed(params: {
    side: string;
    symbol: string;
    reason: string;
  }): Promise<void> {
    const { side, symbol, reason } = params;

    await this.send(
      `❌ <b>Orden fallida — ${side} ${symbol}</b>\n` +
      `<code>${reason}</code>`,
    );
  }

  async notifyMarketOpen(): Promise<void> {
    await this.send(`🟢 <b>Mercado abierto</b> — ${env.SYMBOL}`);
  }

  async notifyMarketClosed(): Promise<void> {
    await this.send(`🔴 <b>Mercado cerrado</b> — ${env.SYMBOL}`);
  }

  async notifyBreakEven(params: { ticket: number; symbol: string; price: number }): Promise<void> {
    await this.send(
      `🔒 <b>Break-even activado</b>\n` +
      `Ticket: <code>${params.ticket}</code> — ${params.symbol}\n` +
      `SL movido a <code>${params.price.toFixed(2)}</code>`,
    );
  }

  async notifyTrailingStop(params: { ticket: number; symbol: string; newSL: number }): Promise<void> {
    await this.send(
      `📈 <b>Trailing stop actualizado</b>\n` +
      `Ticket: <code>${params.ticket}</code> — ${params.symbol}\n` +
      `Nuevo SL: <code>${params.newSL.toFixed(2)}</code>`,
    );
  }

  async notifyBridgeDown(reason: string): Promise<void> {
    await this.send(
      `🔌 <b>Bridge MT5 desconectado</b>\n` +
      `<code>${reason}</code>`,
    );
  }

  async notifyBridgeRecovered(): Promise<void> {
    await this.send(`✅ <b>Bridge MT5 reconectado</b>`);
  }
}
