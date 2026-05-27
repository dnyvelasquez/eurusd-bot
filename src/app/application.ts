import { logger } from '@infra/logger/logger';
import { TelegramService } from '@infra/telegram/telegram.service';
import { LicenseService } from '@infra/license/license.service';
import { NewsFilterService } from '@infra/news/news-filter.service';
import { DailyDrawdownGuard } from '@infra/risk/daily-drawdown.guard';
import { DailyTradeCountGuard } from '@infra/risk/daily-trade-count.guard';
import { ConsecLossGuard } from '@infra/risk/consec-loss.guard';
import { SessionGuard } from '@infra/session/session-guard';
import { TradeJournalService } from '@infra/journal/trade-journal.service';
import { BotStatusService } from '@infra/status/bot-status.service';

import { env } from '@config/env';
import { configService } from '@config/config-service';

import { MarketDataService } from '@bot-core/market-data/market-data.service';
import { BiasEngine } from '@bot-core/strategy/bias/bias-engine';
import { ZoneEngine } from '@bot-core/strategy/zones/zone-engine';
import { MomentumEngine } from '@bot-core/strategy/momentum/momentum-engine';
import { BreakoutEngine } from '@bot-core/strategy/breakout/breakout-engine';
import { FVGDetector } from '@bot-core/strategy/fvg/fvg-detector';
import { DisplacementDetector } from '@bot-core/strategy/fvg/displacement-detector';
import { EntryValidator } from '@bot-core/strategy/entry/entry-validator';
import { PositionSizing } from '@bot-core/strategy/risk/position-sizing';
import { EMAEngine } from '@bot-core/strategy/indicators/ema-engine';
import { MACDEngine } from '@bot-core/strategy/indicators/macd-engine';
import { ExecutionValidator } from '@bot-core/services/execution/execution-validator';
import { MT5Executor } from '@bot-core/services/execution/mt5-executor';
import { PositionMonitor } from '@bot-core/services/execution/position-monitor';
import { MT5Service } from '@bot-core/services/mt5/mt5.service';

import type { SRZone } from '@bot-core/strategy/zones/zone-types';
import type { MomentumSignal } from '@bot-core/strategy/momentum/momentum-types';

const POLL_INTERVAL_MS = 10_000;
const MAX_VOLUME = 20.0;
const MIN_VOLUME = 0.1;

interface ZoneTradeSignal {
  direction: 'BULLISH' | 'BEARISH';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  activeZone: SRZone;
  momentum: MomentumSignal;
  signalType?: 'ZONE' | 'EMA_PB';
}

export class Application {
  private readonly telegramService: TelegramService;
  private readonly marketData: MarketDataService;
  private readonly mt5: MT5Service;

  private readonly biasEngine = new BiasEngine();
  private readonly zoneEngine = new ZoneEngine();
  private readonly momentumEngine = new MomentumEngine();
  private readonly breakoutEngine = new BreakoutEngine();
  private readonly fvgDetector = new FVGDetector();
  private readonly displacementDetector = new DisplacementDetector();
  private readonly entryValidator = new EntryValidator();
  private readonly emaEngine = new EMAEngine();
  private readonly macdEngine = new MACDEngine();
  private readonly positionSizing = new PositionSizing();
  private readonly executionValidator = new ExecutionValidator();
  private readonly executor = new MT5Executor();
  private readonly positionMonitor = new PositionMonitor(
    configService.beAtPoints,
    configService.beBufferPoints,
  );

  private readonly licenseService = new LicenseService();
  private readonly newsFilter = new NewsFilterService();
  private readonly drawdownGuard = new DailyDrawdownGuard();
  private readonly dailyTradeCountGuard = new DailyTradeCountGuard();
  private readonly consecLossGuard = new ConsecLossGuard();
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
  private eodCloseDone = false;
  private dayOpenBalance = 0;
  private consecBadDays = 0;
  private pauseUntilMon = false;

  constructor() {
    this.telegramService = new TelegramService();
    this.marketData = new MarketDataService();
    this.mt5 = new MT5Service();
  }

  public async start(): Promise<void> {
    logger.info('Application starting...');

    await this.validateLicense();

    await this.journal.initialize();

    await this.newsFilter.initialize();

    await this.telegramService.initialize();

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

      const m5 = this.marketData.getCandles(symbol, 'M5').length;
      const h1 = this.marketData.getCandles(symbol, 'H1').length;
      const h4 = this.marketData.getCandles(symbol, 'H4').length;
      const d1 = this.marketData.getCandles(symbol, 'D1').length;

      const isOpen = m5 > 0;

      if (isOpen) {
        logger.info({ symbol, m5, h1, h4, d1 }, 'Sync OK');
        await this.monitorOpenPositions();

        const session = this.sessionGuard.isBlocked(configService.blockedHours);
        if (session.blocked) {
          if (!this.eodCloseDone && this.openPositionTickets.size > 0) {
            await this.closeAllPositionsEOD(symbol);
          }
        } else if (this.pauseUntilMon) {
          logger.debug('Signal evaluation skipped — consecutive bad-days pause active until Monday');
        } else {
          const signal = this.evaluateZoneSignal(symbol) ?? this.evaluateEMAPullbackSignal(symbol);
          if (signal) {
            await this.onZoneSignal(signal).catch((err: unknown) =>
              logger.error(err, 'Error processing zone signal'),
            );
          }
        }
      } else {
        logger.debug('Sync OK — no data (market closed)');
      }

      if (isOpen && !this.marketOpen) {
        this.marketOpen = true;
        this.eodCloseDone = false;
        const accountRes = await this.mt5.getAccount();
        if (accountRes.success && accountRes.data) {
          this.lastKnownBalance = accountRes.data.balance;
          this.dayOpenBalance = accountRes.data.balance;
          this.drawdownGuard.setReference(accountRes.data.balance);
          this.consecLossGuard.resetDay();
        }
        // Monday resets the weekly pause
        const todayIsMonday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()) === 'Mon';
        if (todayIsMonday) { this.consecBadDays = 0; this.pauseUntilMon = false; }
        await this.telegramService.notifyMarketOpen();
      } else if (!isOpen && this.marketOpen) {
        this.marketOpen = false;
        // Track consecutive bad days (days where balance ended below open)
        const maxConsecLossDays = configService.maxConsecLossDays;
        if (maxConsecLossDays > 0 && this.dayOpenBalance > 0) {
          if (this.lastKnownBalance < this.dayOpenBalance) {
            this.consecBadDays++;
            if (this.consecBadDays >= maxConsecLossDays) {
              this.pauseUntilMon = true;
              logger.warn({ consecBadDays: this.consecBadDays, limit: maxConsecLossDays }, 'Consecutive bad-days limit reached — pausing until Monday');
            }
          } else {
            this.consecBadDays = 0;
          }
        }
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
      maxDailyDrawdown:  configService.maxDailyDrawdownPercent,
      dailyTrades:       this.dailyTradeCountGuard.tradeCount(),
      maxDailyTrades:    configService.maxDailyTrades,
      consecStreak:      this.consecLossGuard.currentStreak,
      maxConsecLosses:   configService.maxConsecLosses,
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

  private evaluateZoneSignal(symbol: string): ZoneTradeSignal | null {
    const d1 = this.marketData.getCandles(symbol, 'D1');
    const h4 = this.marketData.getCandles(symbol, 'H4');
    const h1 = this.marketData.getCandles(symbol, 'H1');
    const m15 = this.marketData.getCandles(symbol, 'M15');
    const m5 = this.marketData.getCandles(symbol, 'M5');

    if (d1.length < 10 || h4.length < 10 || h1.length < 10 || m15.length < 10 || m5.length < 10) {
      return null;
    }

    const currentPrice = m5[m5.length - 1].close;

    // ── 1. Zona activa (D1 / H4 / H1) ────────────────────────────────────────
    const zones = this.zoneEngine.getZones(d1, h4, h1, m15);
    const activeZone = this.zoneEngine.findActiveZone(
      zones,
      currentPrice,
      configService.zoneProximityPoints,
    );

    if (!activeZone) return null;

    // ── 2. Sesgo HTF multi-TF ─────────────────────────────────────────────────
    const htfBias = this.biasEngine.analyzeMultiTF(d1, h4, h1);

    if (htfBias === 'RANGE') return null;

    // Zona debe coincidir con el sesgo
    const zoneAligned =
      (htfBias === 'BULLISH' && activeZone.type === 'SUPPORT') ||
      (htfBias === 'BEARISH' && activeZone.type === 'RESISTANCE');

    if (!zoneAligned) return null;

    // ── 3. Momentum M15 ───────────────────────────────────────────────────────
    const momentum = this.momentumEngine.analyze(m15);

    if (momentum.direction === 'NEUTRAL' || momentum.direction !== htfBias) return null;

    // ── 4. FVG y desplazamiento en M5 ────────────────────────────────────────
    const fvgWindow = m5.slice(-7);
    let fvg = null;
    for (let k = fvgWindow.length - 1; k >= 2 && !fvg; k--) {
      const slice = fvgWindow.slice(k - 2, k + 1);
      fvg = htfBias === 'BULLISH'
        ? this.fvgDetector.detectBullish(slice)
        : this.fvgDetector.detectBearish(slice);
    }

    if (fvg && configService.minFvgPoints > 0 && fvg.size < configService.minFvgPoints) {
      return null;
    }

    const dispWindow = m5.slice(-5);
    const displacement = dispWindow.map(c => this.displacementDetector.detect(c)).find(Boolean) ?? null;

    // ── 5. Validación de condiciones ──────────────────────────────────────────
    const valid = this.entryValidator.validate({
      htfBias,
      m15Momentum: momentum.direction,
      hasDisplacement: !!displacement,
      hasFVG: !!fvg,
    });

    if (!valid) {
      logger.debug(
        { htfBias, m15Momentum: momentum.direction, hasFVG: !!fvg, hasDisplacement: !!displacement },
        'Signal rejected — conditions not met',
      );
      return null;
    }

    // ── 6. Niveles de precio ──────────────────────────────────────────────────
    const entryPrice = m5[m5.length - 1].close;
    const stopLoss = htfBias === 'BULLISH'
      ? activeZone.level - configService.zoneSlBufferPoints
      : activeZone.level + configService.zoneSlBufferPoints;

    const slDistance = Math.abs(entryPrice - stopLoss);

    if (configService.minSlPoints > 0 && slDistance < configService.minSlPoints) {
      logger.debug({ slDistance: slDistance.toFixed(2), min: configService.minSlPoints }, 'Signal skipped — SL distance too small');
      return null;
    }

    const takeProfit = htfBias === 'BULLISH'
      ? entryPrice + slDistance * 2
      : entryPrice - slDistance * 2;

    return { direction: htfBias, entryPrice, stopLoss, takeProfit, activeZone, momentum };
  }

  private async closeAllPositionsEOD(symbol: string): Promise<void> {
    this.eodCloseDone = true;
    const response = await this.mt5.getPositions(symbol);
    if (!response.success || !response.data?.length) return;

    logger.warn({ count: response.data.length }, 'EOD — cerrando posiciones abiertas al cierre de sesión');

    for (const position of response.data) {
      const result = await this.mt5.closePosition(position.ticket, symbol);
      if (result.success) {
        logger.info({ ticket: position.ticket }, 'EOD close ejecutado');
      } else {
        logger.error({ ticket: position.ticket, reason: result.message }, 'EOD close fallido');
      }
    }
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
        this.consecLossGuard.recordResult(history.data.profit);
      }
    } catch (err) {
      logger.warn({ ticket, err }, 'Could not fetch position history for journal');
    }
  }

  private evaluateBreakoutPullbackSignal(symbol: string): ZoneTradeSignal | null {
    const d1 = this.marketData.getCandles(symbol, 'D1');
    const h4 = this.marketData.getCandles(symbol, 'H4');
    const h1 = this.marketData.getCandles(symbol, 'H1');
    const m15 = this.marketData.getCandles(symbol, 'M15');
    const m5 = this.marketData.getCandles(symbol, 'M5');

    if (h4.length < 20 || h1.length < 20 || m15.length < 10 || m5.length < 10) return null;

    const currentPrice = m5[m5.length - 1].close;

    // ── 1. Zona rota reciente (pullback a nivel flipeado) ─────────────────────
    const flippedZones = this.breakoutEngine.getFlippedZones(h4, h1);
    const pullbackZone = this.breakoutEngine.findPullbackZone(
      flippedZones,
      currentPrice,
      configService.zoneProximityPoints,
    );

    if (!pullbackZone) return null;

    const direction = pullbackZone.direction;

    // ── 2. Sesgo HTF confirma la dirección del breakout ───────────────────────
    const htfBias = this.biasEngine.analyzeMultiTF(d1, h4, h1);
    if (htfBias !== direction) return null;

    // ── 3. Momentum M15 alineado ──────────────────────────────────────────────
    const momentum = this.momentumEngine.analyze(m15);
    if (momentum.direction !== direction) return null;

    // ── 4. FVG y desplazamiento en M5 ────────────────────────────────────────
    const fvgWindow = m5.slice(-7);
    let fvg = null;
    for (let k = fvgWindow.length - 1; k >= 2 && !fvg; k--) {
      const slice = fvgWindow.slice(k - 2, k + 1);
      fvg = direction === 'BULLISH'
        ? this.fvgDetector.detectBullish(slice)
        : this.fvgDetector.detectBearish(slice);
    }

    if (fvg && configService.minFvgPoints > 0 && fvg.size < configService.minFvgPoints) return null;

    const dispWindow = m5.slice(-5);
    const displacement = dispWindow.map(c => this.displacementDetector.detect(c)).find(Boolean) ?? null;

    const valid = this.entryValidator.validate({
      htfBias: direction,
      m15Momentum: momentum.direction,
      hasDisplacement: !!displacement,
      hasFVG: !!fvg,
    });

    if (!valid) {
      logger.debug(
        { direction, hasFVG: !!fvg, hasDisplacement: !!displacement },
        'Breakout pullback rejected — conditions not met',
      );
      return null;
    }

    // ── 5. Niveles de precio ──────────────────────────────────────────────────
    const entryPrice = m5[m5.length - 1].close;
    const stopLoss = direction === 'BULLISH'
      ? pullbackZone.level - configService.zoneSlBufferPoints
      : pullbackZone.level + configService.zoneSlBufferPoints;

    const slDistance = Math.abs(entryPrice - stopLoss);
    if (configService.minSlPoints > 0 && slDistance < configService.minSlPoints) return null;

    const takeProfit = direction === 'BULLISH'
      ? entryPrice + slDistance * 2
      : entryPrice - slDistance * 2;

    logger.debug(
      { direction, level: pullbackZone.level, tf: pullbackZone.timeframe },
      'Breakout pullback signal detected',
    );

    return {
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      activeZone: {
        level: pullbackZone.level,
        type: pullbackZone.type,
        timeframe: pullbackZone.timeframe,
        strength: pullbackZone.strength,
        candleTime: pullbackZone.breakoutTime,
      },
      momentum,
    };
  }

  private evaluateEMAPullbackSignal(symbol: string): ZoneTradeSignal | null {
    const nowET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).format(new Date());
    const [weekday, hourStr] = nowET.split(', ');
    if (configService.epSkipMonday && weekday === 'Mon') return null;
    if (configService.epMinHour > 0 && parseInt(hourStr ?? '0', 10) < configService.epMinHour) return null;

    const h1 = this.marketData.getCandles(symbol, 'H1');
    const m15 = this.marketData.getCandles(symbol, 'M15');
    const m5 = this.marketData.getCandles(symbol, 'M5');

    if (h1.length < 40 || m15.length < 40 || m5.length < 1) return null;

    const h1Ema8 = this.emaEngine.last(h1, 8);
    const h1Ema34 = this.emaEngine.last(h1, 34);
    if (h1Ema8 === null || h1Ema34 === null) return null;

    const direction: 'BULLISH' | 'BEARISH' = h1Ema8 > h1Ema34 ? 'BULLISH' : 'BEARISH';

    if (configService.emaSpreadMin > 0 && Math.abs(h1Ema8 - h1Ema34) < configService.emaSpreadMin) return null;

    const m15Ema34 = this.emaEngine.last(m15, 34);
    if (m15Ema34 === null) return null;

    if (configService.epM15Align) {
      const m15Ema8 = this.emaEngine.last(m15, 8);
      if (m15Ema8 === null) return null;
      if (direction === 'BULLISH' && m15Ema8 < m15Ema34) return null;
      if (direction === 'BEARISH' && m15Ema8 > m15Ema34) return null;
    }

    const currentPrice = m5[m5.length - 1].close;
    if (Math.abs(currentPrice - m15Ema34) > configService.zoneProximityPoints) return null;

    const macd = this.macdEngine.analyze(m15);
    if (!macd) return null;
    if (direction === 'BULLISH' && macd.histogram <= 0) return null;
    if (direction === 'BEARISH' && macd.histogram >= 0) return null;

    const entryPrice = currentPrice;
    const stopLoss = direction === 'BULLISH'
      ? m15Ema34 - configService.zoneSlBufferPoints
      : m15Ema34 + configService.zoneSlBufferPoints;

    const slDist = Math.abs(entryPrice - stopLoss);
    if (configService.minSlPoints > 0 && slDist < configService.minSlPoints) return null;

    const takeProfit = direction === 'BULLISH'
      ? entryPrice + slDist * 2
      : entryPrice - slDist * 2;

    const syntheticZone: SRZone = {
      level: m15Ema34,
      type: direction === 'BULLISH' ? 'SUPPORT' : 'RESISTANCE',
      timeframe: 'M15',
      strength: 1,
      candleTime: m15[m15.length - 1].time,
    };

    return {
      signalType: 'EMA_PB',
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      activeZone: syntheticZone,
      momentum: { direction, strength: 'NONE', timestamp: m5[m5.length - 1].time },
    };
  }

  private async onZoneSignal(signal: ZoneTradeSignal): Promise<void> {
    const { direction, entryPrice, stopLoss, takeProfit, activeZone, momentum } = signal;
    const symbol = configService.symbol;
    const tag = signal.signalType === 'EMA_PB' ? '[EP]' : '[ZB]';

    logger.info(
      { direction, zone: activeZone.level, zoneTF: activeZone.timeframe, m15Momentum: momentum.strength, tag },
      'Signal detected',
    );

    // ── 0. Filtro de noticias ─────────────────────────────────────────────────
    if (this.newsFilter.isBlocked()) {
      const next = this.newsFilter.nextBlockedEvent();
      logger.info(
        { event: next?.title, time: next?.date.toISOString() },
        'Signal skipped — news blackout window',
      );
      return;
    }

    // ── 0b. Filtro de sesión ──────────────────────────────────────────────────
    const sessionCheck = this.sessionGuard.isBlocked(configService.blockedHours);
    if (sessionCheck.blocked) {
      logger.info({ window: sessionCheck.label }, 'Signal skipped — blocked trading hours');
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
    const lastSignal = this.lastSignalTime.get(direction) ?? 0;
    const elapsed = Date.now() - lastSignal;

    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
      logger.debug({ direction, remaining }, 'Signal skipped — cooldown active');
      return;
    }

    // ── 3. Balance, drawdown y sizing ────────────────────────────────────────
    const accountResponse = await this.mt5.getAccount();

    if (!accountResponse.success || !accountResponse.data) {
      logger.error('Could not retrieve account info — trade skipped');
      return;
    }

    const { balance } = accountResponse.data;
    this.lastKnownBalance = balance;

    if (this.drawdownGuard.isBreached(balance, configService.maxDailyDrawdownPercent)) {
      logger.warn(
        { drawdownPct: this.drawdownGuard.drawdownPct(balance).toFixed(2), limit: configService.maxDailyDrawdownPercent },
        'Signal skipped — daily drawdown limit reached',
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

    const todayET = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10);
    if (this.consecLossGuard.isBlocked(configService.maxConsecLosses, todayET)) {
      logger.warn(
        { streak: this.consecLossGuard.currentStreak, max: configService.maxConsecLosses },
        'Signal skipped — consecutive loss circuit breaker active',
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

    // ── 4. Ejecución ──────────────────────────────────────────────────────────
    const order = {
      symbol,
      side: direction === 'BULLISH' ? ('BUY' as const) : ('SELL' as const),
      volume,
      entryPrice,
      stopLoss,
      takeProfit,
    };

    this.lastSignalTime.set(direction, Date.now());

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
        logger.info({ direction }, 'Semi-auto trade rejected or timed out');
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
