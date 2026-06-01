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
  login: number;
  tradeMode: 'DEMO' | 'CONTEST' | 'REAL';
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

export interface Position {
  ticket: number;
  symbol: string;
  type: 'BUY' | 'SELL';
  volume: number;
  priceOpen: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
}

export interface PositionsResponse {
  success: boolean;
  data?: Position[];
  message?: string;
}

export interface ModifyPositionResponse {
  success: boolean;
  message?: string;
}

export interface PositionHistoryData {
  ticket: number;
  closePrice: number;
  profit: number;
}

export interface PositionHistoryResponse {
  success: boolean;
  data?: PositionHistoryData;
  message?: string;
}

export interface PartialCloseResponse {
  success: boolean;
  message?: string;
}

export interface SymbolInfo {
  point: number;
  tradeTickSize: number;
  tradeTickValue: number;
  tradeContractSize: number;
}

export interface SymbolInfoResponse {
  success: boolean;
  data?: SymbolInfo;
  message?: string;
}