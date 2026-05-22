export type EntryDirection =
  | 'BUY'
  | 'SELL';

export interface TradeSetup {
  direction: EntryDirection;

  entryPrice: number;

  stopLoss: number;

  target: number;

  confidence: number;

  reason: string[];

  timestamp: number;
}