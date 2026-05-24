import TelegramBot from 'node-telegram-bot-api';

import { env } from '@config/env';
import { configService } from '@config/config-service';
import { logger } from '@infra/logger/logger';

interface PendingApproval {
  messageId: number;
  chatId: string;
  baseText: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class TelegramService {
  private readonly bot: TelegramBot;
  private pendingApproval: PendingApproval | null = null;

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

    this.bot.on('callback_query', (q) => this.handleCallbackQuery(q));

    if (configService.semiAutoMode) {
      await this.bot.startPolling();
      logger.info('Telegram polling started (semi-auto mode)');
    }
  }

  private handleCallbackQuery(query: TelegramBot.CallbackQuery): void {
    if (!this.pendingApproval) {
      this.bot.answerCallbackQuery(query.id, { text: 'No hay trade pendiente' }).catch(() => {});
      return;
    }
    if (query.message?.message_id !== this.pendingApproval.messageId) {
      this.bot.answerCallbackQuery(query.id, { text: 'Trade ya procesado' }).catch(() => {});
      return;
    }

    const approved = query.data === 'execute';
    this.bot.answerCallbackQuery(query.id, {
      text: approved ? '✅ Ejecutando orden...' : '❌ Trade ignorado',
    }).catch(() => {});

    const statusSuffix = approved
      ? '\n\n✅ <b>Aprobado — ejecutando orden</b>'
      : '\n\n❌ <b>Ignorado por el usuario</b>';
    this.bot.editMessageText(this.pendingApproval.baseText + statusSuffix, {
      chat_id: this.pendingApproval.chatId,
      message_id: this.pendingApproval.messageId,
      parse_mode: 'HTML',
    }).catch(() => {});

    const { resolve, timer } = this.pendingApproval;
    clearTimeout(timer);
    this.pendingApproval = null;
    resolve(approved);
  }

  async sendTradeApproval(params: {
    side: string; symbol: string; entry: number; sl: number; tp: number;
    volume: number; rr: string; riskAmount: string;
  }, timeoutMs = 180_000): Promise<boolean> {
    if (!env.TELEGRAM_CHAT_ID) return false;

    const { side, symbol, entry, sl, tp, volume, rr, riskAmount } = params;
    const slDist = Math.abs(entry - sl).toFixed(2);
    const tpDist = Math.abs(tp - entry).toFixed(2);

    const baseText =
      `📋 <b>Setup detectado — ${side} ${symbol}</b>\n` +
      `<i>Responde en los próximos 3 minutos…</i>\n\n` +
      `Entry:  <code>${entry.toFixed(2)}</code>\n` +
      `SL:     <code>${sl.toFixed(2)}</code>  (${slDist} pts)\n` +
      `TP:     <code>${tp.toFixed(2)}</code>  (+${tpDist} pts)\n\n` +
      `Vol: ${volume} | R:R: ${rr} | Riesgo: $${riskAmount}`;

    const msg = await this.bot.sendMessage(env.TELEGRAM_CHAT_ID, baseText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ejecutar', callback_data: 'execute' },
          { text: '❌ Ignorar',  callback_data: 'ignore'  },
        ]],
      },
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApproval?.messageId === msg.message_id) {
          this.bot.editMessageText(
            baseText + '\n\n⏱ <i>Sin respuesta — trade cancelado</i>',
            { chat_id: env.TELEGRAM_CHAT_ID!, message_id: msg.message_id, parse_mode: 'HTML' },
          ).catch(() => {});
          this.pendingApproval = null;
          resolve(false);
        }
      }, timeoutMs);

      this.pendingApproval = {
        messageId: msg.message_id,
        chatId: env.TELEGRAM_CHAT_ID!,
        baseText,
        resolve,
        timer,
      };
    });
  }

  public async stop(): Promise<void> {
    await this.bot.stopPolling().catch(() => {});
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

  async notifyPartialTP(params: { ticket: number; symbol: string; volume: number; price: number }): Promise<void> {
    await this.send(
      `📊 <b>Partial TP ejecutado</b>\n` +
      `Ticket: <code>${params.ticket}</code> — ${params.symbol}\n` +
      `Cerrado: ${params.volume} lotes @ <code>${params.price.toFixed(2)}</code>\n` +
      `SL movido a break-even`,
    );
  }
}
