import { logger } from '@infra/logger/logger';
import { TelegramService } from '@infra/telegram/telegram.service';
import { LicenseService } from '@infra/license/license.service';
import { NewsFilterService } from '@infra/news/news-filter.service';

import { env } from '@config/env';
import { configService } from '@config/config-service';

import { MarketDataService } from '@bot-core/market-data/market-data.service';
import { StrategyEngine } from '@bot-core/core/strategy-engine';
import { marketEvents } from '@bot-core/market-data/market-events';
import { SwingDetector } from '@bot-core/strategy/structure/swing-detector';
import { BiasEngine } from '@bot-core/strategy/bias/bias-engine';
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
const MAX_VOLUME = 1.0;
const MIN_VOLUME = 0.01;
const SL_BUFFER_RATIO = 0.1;

export class Application {
  private readonly telegramService: TelegramService;
  private readonly marketData: MarketDataService;
  private readonly strategy: StrategyEngine;
  private readonly mt5: MT5Service;

  private readonly swingDetector = new SwingDetector();
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
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly lastSignalTime = new Map<'BULLISH' | 'BEARISH', number>();
  private bridgeDown = false;
  private marketOpen = false;

  constructor() {
    this.telegramService = new TelegramService();
    this.marketData = new MarketDataService();
    this.strategy = new StrategyEngine();
    this.mt5 = new MT5Service();
  }

  public async start(): Promise<void> {
    logger.info('Application starting...');

    await this.validateLicense();

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

  private async validateLicense(): Promise<void> {
    const accountResponse = await this.mt5.getAccount();

    if (!accountResponse.success || !accountResponse.data) {
      throw new Error('Cannot reach MT5 bridge — start the bridge before the bot');
    }

    const { login, tradeMode } = accountResponse.data;

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
        await this.telegramService.notifyMarketOpen();
      } else if (!isOpen && this.marketOpen) {
        this.marketOpen = false;
        await this.telegramService.notifyMarketClosed();
      }

      if (this.bridgeDown) {
        this.bridgeDown = false;
        await this.telegramService.notifyBridgeRecovered();
      }
    } catch (err) {
      logger.error(err, 'Sync failed — bridge unreachable');

      if (!this.bridgeDown) {
        this.bridgeDown = true;
        await this.telegramService.notifyBridgeDown(String(err));
      }
    }
  }

  private refreshLiquidityLevels(): number {
    const h1Candles = this.marketData.getCandles(configService.symbol, 'H1');

    if (h1Candles.length < 5) return 0;

    const swings = this.swingDetector.detectSwings(h1Candles);

    const levels: LiquidityLevel[] = swings.map((swing) => ({
      price: swing.price,
      type: swing.type === 'HIGH' ? 'BSL' : 'SSL',
      touches: 1,
      firstTouchTime: swing.time,
    }));

    this.strategy.getLiquidityEngine().addLevels(levels);

    return levels.length;
  }

  private async monitorOpenPositions(): Promise<void> {
    const response = await this.mt5.getPositions(configService.symbol);

    if (!response.success || !response.data?.length) return;

    for (const position of response.data) {
      const tickResponse = await this.mt5.getTick(position.symbol);

      if (!tickResponse.success) continue;

      const currentPrice =
        position.type === 'BUY' ? tickResponse.data.bid : tickResponse.data.ask;

      const action = this.positionMonitor.check(position, currentPrice);

      if (!action) continue;

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

    const mssDirection = mss.direction;
    const sweepDirection = sweep.direction === 'bullish' ? 'BULLISH' : 'BEARISH';

    // ── 4. FVG y desplazamiento en M5 ────────────────────────────────────────
    const recentM5 = m5Candles.slice(-3);
    const lastM5 = m5Candles[m5Candles.length - 1];

    const fvg =
      mssDirection === 'BULLISH'
        ? this.fvgDetector.detectBullish(recentM5)
        : this.fvgDetector.detectBearish(recentM5);

    const displacement = this.displacementDetector.detect(lastM5);

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
    // Entrada: midpoint del FVG si existe, de lo contrario cierre de la última vela M5
    const entryPrice = fvg
      ? (fvg.startPrice + fvg.endPrice) / 2
      : lastM5.close;

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

    // ── 7. Balance y sizing ───────────────────────────────────────────────────
    const accountResponse = await this.mt5.getAccount();

    if (!accountResponse.success || !accountResponse.data) {
      logger.error('Could not retrieve account info — trade skipped');
      return;
    }

    const { balance } = accountResponse.data;

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
      Math.max(MIN_VOLUME, Math.round(sizing.positionSize * 100) / 100),
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
  }
}
