import axios from "axios";

import {
  TickResponse,
  CandlesResponse,
  AccountResponse,
} from "./mt5.types";

export class MT5Service {

  private readonly baseUrl =
    "http://127.0.0.1:8000/api/trading";

  async getTick(
    symbol: string
  ): Promise<TickResponse> {

    const response = await axios.get<TickResponse>(
      `${this.baseUrl}/tick/${symbol}`
    );

    return response.data;
  }

  async getAccount(): Promise<AccountResponse> {
    const response = await axios.get<AccountResponse>(
      `${this.baseUrl}/account`
    );

    return response.data;
  }

  async getCandles(
    symbol: string,
    timeframe: string,
    count = 100
  ): Promise<CandlesResponse> {

    const response =
      await axios.get<CandlesResponse>(
        `${this.baseUrl}/candles/${symbol}/${timeframe}?count=${count}`
      );

    return response.data;
  }
}