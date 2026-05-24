export interface TickData {
  bid: number;
  ask: number;
  last: number;
  time: number;
}

export interface TickResponse {
  success: boolean;
  symbol: string;
  data: TickData;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
}

export interface CandlesResponse {
  success: boolean;
  symbol: string;
  timeframe: string;
  count: number;
  data: Candle[];
}

export interface AccountInfo {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
}

export interface AccountResponse {
  success: boolean;
  data?: AccountInfo;
  message?: string;
}