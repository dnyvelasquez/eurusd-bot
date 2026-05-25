import { logger } from '@infra/logger/logger';
import { TelegramService } from '@infra/telegram/telegram.service';
import { LicenseService } from '@infra/license/license.service';
import { NewsFilterService } from '@infra/news/news-filter.service';
import { DailyDrawdownGuard } from '@infra/risk/daily-drawdown.guard';
import { DailyProfitTargetGuard } from '@infra/risk/daily-profit-target.guard';
import { WeeklyDrawdownGuard } from '@infra/risk/weekly-drawdown.guard';
import { DailyTradeCountGuard } from '@infra/risk/daily-trade-count.guard';
import { SessionGuard } from '@infra/session/session-guard';
import { TradeJournalService } from '@infra/journal/trade-journal.service';
import { BotStatusService } from '@infra/status/bot-status.service';

import { env } from '@config/env';
import { configService } from '@config/config-service';

import { MarketDataService } from '@bot-core/market-data/market-data.service';
import { StrategyEngine } from '@bot-core/core/strategy-engine';
import { marketEvents } from '@bot-core/market-data/market-events';
import { BiasEngine } from '@bot-core/strategy/bias/bias-engine';
import { detectEqualHighs, detectEqualLows } from '@bot-core/strategy/liquidity/equal-levels';
import { FVGDetector } from '@bot-core/strategy/fvg/fvg-detector';
import { DisplacementDetector } from '@bot-core/strategy/fvg/displacement-detector';
import { EntryValidator } from '@bot-core/strategy/entry/entry-validator';
import { PositionSizing } from '@bot-core/strategy/risk/position-sizing';
import { ExecutionValidator } from '@bot-core/services/execution/execution-validator';
import { MT5Executor } from '@bot-core/services/execution/mt5-executor';
import { PositionMonitor } from '@bot-core/services/execution/position-monitor';
import { MT5Service } from '@bot-core/services/mt5/mt5.service';

import type { LiquidityLevel, LiquiditySweep } from '@bot-core/strategy/liquidity/liquidity.types';
import type { MSS } from '@bot-core/strategy/mss/mss-types';

const POLL_INTERVAL_MS = 10_000;
const MAX_VOLUME = 20.0;
const MIN_VOLUME = 0.1;
const SL_BUFFER_RATIO = 0.1;

export class Application {
  private readonly telegramService: TelegramService;
  private readonly marketData: MarketDataService;
  private readonly strategy: StrategyEngine;
  private readonly mt5: MT5Service;

  private readonly biasEngine = new BiasEngine();
  private readonly fvgDetector = new FVGDetector();
  private readonly displacementDetector = new DisplacementDetector();
  private readonly entryValidator = new EntryValidator();
  private readonly positionSizing = new PositionSizing();
  private readonly executionValidator = new ExecutionValidator();
  private readonly executor = new MT5Executor();
  private readonly positionMonitor = new PositionMonitor();

  private readonly licenseService = new LicenseService();
  private readonly newsFilter = new NewsFilterService();
  private readonly drawdownGuard = new DailyDrawdownGuard();
  private readonly profitTargetGuard = new DailyProfitTargetGuard();
  private readonly weeklyDrawdownGuard = new WeeklyDrawdownGuard();
  private readonly dailyTradeCountGuard = new DailyTradeCountGuard();
  private readonly sessionGuard = new SessionGuard();
  private readonly journal = new TradeJournalService();
  private readonly statusService = new BotStatusService();
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly lastSignalTime = new Map<'BULLISH' | 'BEARISH', number>();
  private openPositionTickets = new Set<number>();
  private mt5Login = 0;
  private lastKnownBalance = 0;
  private bridgeDown = false;
  private marketOpen = false;
  private approvalPending = false;

  constructor() {
    this.telegramService = new TelegramService();
    this.marketData = new MarketDataService();
    this.strategy = new StrategyEngine();
    this.mt5 = new MT5Service();
  }

  public async start(): Promise<void> {
    logger.info('Application starting...');

    await this.validateLicense();

    await this.journal.initialize();

    await this.newsFilter.initialize();

    await this.telegramService.initialize();

    this.strategy.initialize();

    this.strategy.on('mssConfirmed', ({ sweep, mss }: { sweep: LiquiditySweep; mss: MSS }) => {
      this.onMssConfirmed(sweep, mss).catch((err: unknown) =>
        logger.error(err, 'Error processing MSS signal'),
      );
    });

    marketEvents.on('new-candle', ({ candle }: { candle: any }) => {
      this.strategy.processCandle(candle);
    });

    await this.sync();

    this.pollTimer = setInterval(
      () => {
        this.sync().catch((err: unknown) => logger.error(err, 'Unexpected sync error'));
      },
      POLL_INTERVAL_MS,
    );

    logger.info(
      `Application started — symbol: ${configService.symbol} | ` +
      `risk: ${configService.riskPercent}% | ` +
      `live trading: ${configService.liveTrading}`,
    );

    await this.telegramService.notifyStartup(configService.symbol, configService.riskPercent, configService.liveTrading);
  }

  private async waitForBridge(maxRetries = 12, delayMs = 5_000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.mt5.getAccount();
        if (res.success) return;
      } catch {}
      if (attempt < maxRetries) {
        logger.warn({ attempt, maxRetries, retryInMs: delayMs }, 'Bridge not ready — retrying...');
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(`Bridge unreachable after ${maxRetries} attempts — is uvicorn running?`);
  }

  private async validateLicense(): Promise<void> {
    await this.waitForBridge();

    const accountResponse = await this.mt5.getAccount();

    if (!accountResponse.success || !accountResponse.data) {
      throw new Error('Cannot reach MT5 bridge — start the bridge before the bot');
    }

    const { login, tradeMode } = accountResponse.data;
    this.mt5Login = login;

    try {
      await this.licenseService.validate(login, tradeMode);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ reason }, 'License validation failed — bot will not start');
      throw err;
    }
  }

  private async sync(): Promise<void> {
    const symbol = configService.symbol;
    try {
      await this.marketData.syncSymbol(symbol);
      const levels = this.refreshLiquidityLevels();

      const m1 = this.marketData.getCandles(symbol, 'M1').length;
      const h1 = this.marketData.getCandles(symbol, 'H1').length;

      const isOpen = m1 > 0;

      if (isOpen) {
        logger.info({ symbol, m1, h1, levels }, 'Sync OK');
        await this.monitorOpenPositions();
      } else {
        logger.debug('Sync OK — no data (market closed)');
      }

      if (isOpen && !this.marketOpen) {
        this.marketOpen = true;
        const accountRes = await this.mt5.getAccount();
        if (accountRes.success && accountRes.data) {
          this.lastKnownBalance = accountRes.data.balance;
          this.drawdownGuard.setReference(accountRes.data.balance);
          this.profitTargetGuard.setReference(accountRes.data.balance);
          this.weeklyDrawdownGuard.setReference(accountRes.data.balance);
        }
        await this.telegramService.notifyMarketOpen();
      } else if (!isOpen && this.marketOpen) {
        this.marketOpen = false;
        await this.telegramService.notifyMarketClosed();
      }

      if (this.bridgeDown) {
        this.bridgeDown = false;
        await this.telegramService.notifyBridgeRecovered();
      }

      this.writeStatus();
    } catch (err) {
      logger.error(err, 'Sync failed — bridge unreachable');

      if (!this.bridgeDown) {
        this.bridgeDown = true;
        await this.telegramService.notifyBridgeDown(String(err));
      }

      this.writeStatus();
    }
  }

  private writeStatus(): void {
    const now = new Date().toISOString();

    const metrics = {
      dailyDrawdownPct:  Math.max(0, this.drawdownGuard.drawdownPct(this.lastKnownBalance)),
      dailyProfitPct:    Math.max(0, this.profitTargetGuard.profitPct(this.lastKnownBalance)),
      weeklyDrawdownPct: Math.max(0, this.weeklyDrawdownGuard.drawdownPct(this.lastKnownBalance)),
      maxDailyDrawdown:  configService.maxDailyDrawdownPercent,
      maxDailyProfit:    configService.maxDailyProfitPercent,
      maxWeeklyDrawdown: configService.maxWeeklyDrawdownPercent,
      dailyTrades:       this.dailyTradeCountGuard.tradeCount(),
      maxDailyTrades:    configService.maxDailyTrades,
    };

    const write = (ready: boolean, reason: string | null) =>
      this.statusService.write({ ready, reason, updatedAt: now, metrics });

    if (this.bridgeDown) { write(false, 'Bridge MT5 no disponible — reconectando...'); return; }

    if (!this.marketOpen) { write(false, 'Mercado cerrado'); return; }

    const session = this.sessionGuard.isBlocked(configService.blockedHours);
    if (session.blocked) { write(false, `Horario bloqueado — ${session.label}`); return; }

    if (this.newsFilter.isBlocked()) {
      const next = this.newsFilter.nextBlockedEvent();
      write(false, `Noticias — ${next?.title ?? 'evento USD de alto impacto'}`);
      return;
    }

    if (this.lastKnownBalance > 0) {
      if (this.drawdownGuard.isBreached(this.lastKnownBalance, configService.maxDailyDrawdownPercent)) {
        write(false, `Límite de pérdida diaria (${metrics.dailyDrawdownPct.toFixed(1)}% / ${metrics.maxDailyDrawdown}%)`);
        return;
      }
      if (this.profitTargetGuard.isReached(this.lastKnownBalance, configService.maxDailyProfitPercent)) {
        write(false, `Objetivo de ganancia alcanzado (${metrics.dailyProfitPct.toFixed(1)}% / ${metrics.maxDailyProfit}%)`);
        return;
      }
      if (this.weeklyDrawdownGuard.isBreached(this.lastKnownBalance, configService.maxWeeklyDrawdownPercent)) {
        write(false, `Límite de pérdida semanal (${metrics.weeklyDrawdownPct.toFixed(1)}% / ${metrics.maxWeeklyDrawdown}%)`);
        return;
      }
    }

    if (this.dailyTradeCountGuard.isBreached(configService.maxDailyTrades)) {
      write(false, `Máximo de trades diarios (${metrics.dailyTrades}/${metrics.maxDailyTrades})`);
      return;
    }

    const cooldownMs = configService.signalCooldownMinutes * 60_000;
    const bullishElapsed = Date.now() - (this.lastSignalTime.get('BULLISH') ?? 0);
    const bearishElapsed = Date.now() - (this.lastSignalTime.get('BEARISH') ?? 0);

    if (bullishElapsed < cooldownMs && bearishElapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - Math.max(bullishElapsed, bearishElapsed)) / 60_000);
      write(false, `Cooldown activo — ${remaining} min restantes`);
      return;
    }

    write(true, null);
  }

  private refreshLiquidityLevels(): number {
    const m5Candles = this.marketData.getCandles(configService.symbol, 'M5');

    if (m5Candles.length < 20) return 0;

    const levels: LiquidityLevel[] = [
      ...detectEqualHighs(m5Candles),
      ...detectEqualLows(m5Candles),
    ];

    this.strategy.getLiquidityEngine().addLevels(levels);

    return levels.length;
  }

  private async monitorOpenPositions(): Promise<void> {
    const response = await this.mt5.getPositions(configService.symbol);

    if (!response.success) return;

    const currentPositions = response.data ?? [];
    const currentTickets = new Set(currentPositions.map((p) => p.ticket));

    // Detect closed positions and update journal
    for (const ticket of this.openPositionTickets) {
      if (!currentTickets.has(ticket)) {
        await this.onPositionClosed(ticket);
      }
    }
    this.openPositionTickets = currentTickets;

    // Monitor open positions (break-even / trailing stop)
    for (const position of currentPositions) {
      const tickResponse = await this.mt5.getTick(position.symbol);

      if (!tickResponse.success) continue;

      const currentPrice =
        position.type === 'BUY' ? tickResponse.data.bid : tickResponse.data.ask;

      const action = this.positionMonitor.check(position, currentPrice, configService.partialTpEnabled);

      if (!action) continue;

      // Partial TP: cerrar 50% y mover SL a break-even
      if (action.reason === 'PARTIAL_TP' && action.partialVolume !== undefined) {
        const closeResult = await this.mt5.partialClose(action.ticket, action.partialVolume, action.symbol);
        if (!closeResult.success) {
          logger.error({ ticket: action.ticket, reason: closeResult.message }, 'Partial close failed');
          continue;
        }
        await this.mt5.modifyPosition(action.ticket, action.symbol, action.newSL, action.keepTP);
        logger.info({ ticket: action.ticket, volume: action.partialVolume, newSL: action.newSL }, 'Partial TP executed');
        await this.telegramService.notifyPartialTP({
          ticket: action.ticket,
          symbol: action.symbol,
          volume: action.partialVolume,
          price: currentPrice,
        });
        continue;
      }

      const result = await this.mt5.modifyPosition(
        action.ticket,
        action.symbol,
        action.newSL,
        action.keepTP,
      );

      if (!result.success) {
        logger.error({ ticket: action.ticket, reason: action.reason }, 'Position modify failed');
        continue;
      }

      logger.info({ ticket: action.ticket, newSL: action.newSL, reason: action.reason }, 'Position modified');

      if (action.reason === 'BREAK_EVEN') {
        await this.telegramService.notifyBreakEven({
          ticket: action.ticket,
          symbol: action.symbol,
          price: action.newSL,
        });
      } else {
        await this.telegramService.notifyTrailingStop({
          ticket: action.ticket,
          symbol: action.symbol,
          newSL: action.newSL,
        });
      }
    }
  }

  private async onPositionClosed(ticket: number): Promise<void> {
    this.positionMonitor.clearTicket(ticket);
    try {
      const history = await this.mt5.getPositionHistory(ticket);
      if (history.success && history.data) {
        await this.journal.recordClose(ticket, history.data.closePrice, history.data.profit);
      }
    } catch (err) {
      logger.warn({ ticket, err }, 'Could not fetch position history for journal');
    }
  }

  private async onMssConfirmed(sweep: LiquiditySweep, mss: MSS): Promise<void> {
    logger.info({ direction: mss.direction, brokenPrice: mss.brokenPrice }, 'MSS confirmed');

    // ── 0. Filtro de noticias ─────────────────────────────────────────────────
    if (this.newsFilter.isBlocked()) {
      const next = this.newsFilter.nextBlockedEvent();
      logger.info(
        { event: next?.title, time: next?.date.toISOString() },
        'Signal skipped — news blackout window (±1 min USD high-impact event)',
      );
      return;
    }

    // ── 0b. Filtro de sesión (horarios bloqueados) ────────────────────────────
    const sessionCheck = this.sessionGuard.isBlocked(configService.blockedHours);
    if (sessionCheck.blocked) {
      logger.info({ window: sessionCheck.label }, 'Signal skipped — blocked trading hours');
      return;
    }

    const symbol = configService.symbol;
    const h1Candles = this.marketData.getCandles(symbol, 'H1');
    const m5Candles = this.marketData.getCandles(symbol, 'M5');

    if (h1Candles.length < 10 || m5Candles.length < 3) {
      logger.warn('Not enough candles to evaluate signal');
      return;
    }

    // ── 1. Posiciones abiertas ────────────────────────────────────────────────
    const positionsResponse = await this.mt5.getPositions(symbol);

    if (!positionsResponse.success) {
      logger.error('Could not check open positions — trade skipped');
      return;
    }

    const openPositions = positionsResponse.data ?? [];

    if (openPositions.length > 0) {
      logger.debug(
        { count: openPositions.length, tickets: openPositions.map((p) => p.ticket) },
        'Signal skipped — position already open',
      );
      return;
    }

    // ── 2. Cooldown ───────────────────────────────────────────────────────────
    const cooldownMs = configService.signalCooldownMinutes * 60_000;
    const lastSignal = this.lastSignalTime.get(mss.direction) ?? 0;
    const elapsed = Date.now() - lastSignal;

    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
      logger.debug({ direction: mss.direction, remaining }, 'Signal skipped — cooldown active');
      return;
    }

    // ── 3. Sesgo HTF ──────────────────────────────────────────────────────────
    const htfBias = this.biasEngine.analyze(h1Candles);

    if (htfBias === 'RANGE') {
      logger.debug('Signal skipped — HTF bias is RANGE');
      return;
    }

    // ── 3b. Confirmación M15 (opcional) ─────────────────────────────────────
    if (configService.m15ConfirmationEnabled) {
      const m15Candles = this.marketData.getCandles(symbol, 'M15');
      const m15Bias = this.biasEngine.analyze(m15Candles);
      if (m15Bias !== htfBias) {
        logger.debug({ htfBias, m15Bias }, 'Signal skipped — M15 bias not aligned with H1');
        return;
      }
    }

    const mssDirection = mss.direction;
    const sweepDirection = sweep.direction === 'bullish' ? 'BULLISH' : 'BEARISH';

    // ── 4. FVG y desplazamiento en M5 ────────────────────────────────────────
    const lastM5 = m5Candles[m5Candles.length - 1];

    // Search FVG in the last 7 candles — the FVG forms during the displacement candle
    // (2–5 candles before MSS confirmation), not at the MSS candle itself.
    const fvgWindow = m5Candles.slice(-7);
    let fvg = null;
    for (let k = fvgWindow.length - 1; k >= 2 && !fvg; k--) {
      const slice = fvgWindow.slice(k - 2, k + 1);
      fvg = mssDirection === 'BULLISH'
        ? this.fvgDetector.detectBullish(slice)
        : this.fvgDetector.detectBearish(slice);
    }

    // Filtro de tamaño de FVG
    if (fvg && configService.minFvgPoints > 0 && fvg.size < configService.minFvgPoints) {
      logger.debug(
        { fvgSize: fvg.size.toFixed(2), min: configService.minFvgPoints },
        'Signal skipped — FVG too small',
      );
      return;
    }

    // Check displacement in the last 5 candles — the strong impulse precedes the MSS.
    const dispWindow = m5Candles.slice(-5);
    const displacement = dispWindow.map(c => this.displacementDetector.detect(c)).find(Boolean) ?? null;

    // ── 5. Validación de condiciones de entrada ───────────────────────────────
    const valid = this.entryValidator.validate({
      htfBias,
      sweepDirection,
      mssDirection,
      hasDisplacement: !!displacement,
      hasFVG: !!fvg,
    });

    if (!valid) {
      logger.debug(
        { htfBias, sweepDirection, mssDirection, hasFVG: !!fvg, hasDisplacement: !!displacement },
        'Signal rejected — conditions not met',
      );
      return;
    }

    // ── 6. Niveles de precio ──────────────────────────────────────────────────
    // FVG validates setup quality; execution is always a market order, not limit at FVG midpoint
    const entryPrice = lastM5.close;

    // SL: más allá del extremo del sweep con un buffer del 10% del rango de esa vela
    const sweepRange = sweep.sweepCandleHigh - sweep.sweepCandleLow;
    const buffer = sweepRange * SL_BUFFER_RATIO;

    const stopLoss =
      mssDirection === 'BULLISH'
        ? sweep.sweepCandleLow - buffer
        : sweep.sweepCandleHigh + buffer;

    // TP: mínimo 2:1 R:R
    const slDistance = Math.abs(entryPrice - stopLoss);
    const takeProfit =
      mssDirection === 'BULLISH'
        ? entryPrice + slDistance * 2
        : entryPrice - slDistance * 2;

    // ── 7. Balance, drawdown y sizing ────────────────────────────────────────
    const accountResponse = await this.mt5.getAccount();

    if (!accountResponse.success || !accountResponse.data) {
      logger.error('Could not retrieve account info — trade skipped');
      return;
    }

    const { balance } = accountResponse.data;
    this.lastKnownBalance = balance;

    if (this.drawdownGuard.isBreached(balance, configService.maxDailyDrawdownPercent)) {
      logger.warn(
        {
          drawdownPct: this.drawdownGuard.drawdownPct(balance).toFixed(2),
          limit: configService.maxDailyDrawdownPercent,
        },
        'Signal skipped — daily drawdown limit reached',
      );
      return;
    }

    if (this.profitTargetGuard.isReached(balance, configService.maxDailyProfitPercent)) {
      logger.info(
        {
          profitPct: this.profitTargetGuard.profitPct(balance).toFixed(2),
          target: configService.maxDailyProfitPercent,
        },
        'Signal skipped — daily profit target reached',
      );
      return;
    }

    if (this.weeklyDrawdownGuard.isBreached(balance, configService.maxWeeklyDrawdownPercent)) {
      logger.warn(
        {
          drawdownPct: this.weeklyDrawdownGuard.drawdownPct(balance).toFixed(2),
          limit: configService.maxWeeklyDrawdownPercent,
        },
        'Signal skipped — weekly drawdown limit reached',
      );
      return;
    }

    if (this.dailyTradeCountGuard.isBreached(configService.maxDailyTrades)) {
      logger.info(
        { count: this.dailyTradeCountGuard.tradeCount(), max: configService.maxDailyTrades },
        'Signal skipped — daily trade limit reached',
      );
      return;
    }

    const sizing = this.positionSizing.calculate({
      accountBalance: balance,
      riskPercent: configService.riskPercent,
      entryPrice,
      stopLoss,
      target: takeProfit,
    });

    if (sizing.riskRewardRatio < 2) {
      logger.debug({ rr: sizing.riskRewardRatio.toFixed(2) }, 'Signal rejected — R:R below 2:1');
      return;
    }

    const volume = Math.min(
      MAX_VOLUME,
      Math.max(MIN_VOLUME, Math.round(sizing.positionSize * 10) / 10),
    );

    // ── 8. Ejecución ──────────────────────────────────────────────────────────
    const order = {
      symbol,
      side: mssDirection === 'BULLISH' ? ('BUY' as const) : ('SELL' as const),
      volume,
      entryPrice,
      stopLoss,
      takeProfit,
    };

    this.lastSignalTime.set(mssDirection, Date.now());

    const notifParams = {
      side: order.side,
      symbol: order.symbol,
      entry: entryPrice,
      sl: stopLoss,
      tp: takeProfit,
      volume,
      rr: sizing.riskRewardRatio.toFixed(2),
      riskAmount: sizing.riskAmount.toFixed(2),
    };

    if (!configService.liveTrading) {
      logger.info(
        { ...order, rr: notifParams.rr, riskAmount: notifParams.riskAmount },
        '[PAPER] Trade setup',
      );
      await this.telegramService.notifyPaperSetup(notifParams);
      return;
    }

    // ── Semi-auto mode: pedir aprobación por Telegram ─────────────────────────
    if (configService.semiAutoMode) {
      if (this.approvalPending) {
        logger.debug('Signal skipped — trade approval already pending');
        return;
      }
      this.approvalPending = true;
      let approved = false;
      try {
        approved = await this.telegramService.sendTradeApproval(notifParams);
      } finally {
        this.approvalPending = false;
      }
      if (!approved) {
        logger.info({ direction: mss.direction }, 'Semi-auto trade rejected or timed out');
        return;
      }
    }

    logger.info({ ...order, rr: notifParams.rr, riskAmount: notifParams.riskAmount }, 'Placing order');

    const orderValid = this.executionValidator.validate(order);

    if (!orderValid) {
      logger.error({ order }, 'Order failed internal validation — not sent');
      return;
    }

    const result = await this.executor.execute(order);

    if (result.success) {
      logger.info({ orderId: result.orderId }, 'Order placed successfully');
      await this.telegramService.notifyOrderPlaced({ ...notifParams, orderId: result.orderId });
      this.dailyTradeCountGuard.increment();

      if (result.orderId !== undefined) {
        this.openPositionTickets.add(result.orderId);
        await this.journal.recordOpen({
          ticket: result.orderId,
          mt5Login: this.mt5Login,
          symbol: order.symbol,
          side: order.side,
          volume: order.volume,
          entryPrice,
          stopLoss,
          takeProfit,
          plannedRr: sizing.riskRewardRatio,
          riskAmount: sizing.riskAmount,
        });
      }
    } else {
      logger.error({ message: result.message }, 'Order failed');
      await this.telegramService.notifyOrderFailed({ side: order.side, symbol: order.symbol, reason: result.message });
    }
  }

  public async stop(): Promise<void> {
    logger.info('Application stopping...');

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    configService.stop();
    this.newsFilter.stop();
    await this.telegramService.stop();
  }
}
