export type TradeResult = 'WIN' | 'LOSS' | 'OPEN';
export type SignalType = 'ZONE' | 'BREAKOUT' | 'EMA_PB';

export interface BacktestTrade {
  tradeNumber: number;
  signalType: SignalType;
  direction: 'BULLISH' | 'BEARISH';
  side: 'BUY' | 'SELL';
  openTime: number;
  closeTime: number | null;
  openTimeISO: string;
  closeTimeISO: string | null;
  entry: number;
  sl: number;
  tp: number;
  plannedRr: number;
  actualRr: number | null;
  result: TradeResult;
  pnl: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  openTrades: number;
  winRate: number;
  profitFactor: number;
  avgRr: number;
  avgWinRr: number;
  avgLossRr: number;
  totalPnl: number;
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
}

export interface BacktestReport {
  symbol: string;
  from: string;
  to: string;
  initialBalance: number;
  finalBalance: number;
  riskPercent: number;
  cooldownMinutes: number;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  generatedAt: string;
}
