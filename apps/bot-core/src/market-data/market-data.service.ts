import { MT5Service }
  from "../services/mt5/mt5.service";

import { Candle }
  from "../services/mt5/mt5.types";

import { CandleCache }
  from "./candle-cache";

import { marketEvents }
  from "./market-events";

export class MarketDataService {

  private mt5 =
    new MT5Service();

  private cache =
    new CandleCache();

  async loadCandles(
    symbol: string,
    timeframe: string,
    count = 200
  ) {

    const response =
      await this.mt5.getCandles(
        symbol,
        timeframe,
        count
      );

    const key =
      `${symbol}_${timeframe}`;

    const previous =
      this.cache.get(key);

    this.cache.set(
      key,
      response.data
    );

    this.detectNewCandle(
      key,
      previous,
      response.data
    );
  }

  private detectNewCandle(
    key: string,
    oldCandles: Candle[],
    newCandles: Candle[]
  ) {

    if (
      oldCandles.length === 0 ||
      newCandles.length === 0
    ) {
      return;
    }

    const oldLast =
      oldCandles[
        oldCandles.length - 1
      ];

    const newLast =
      newCandles[
        newCandles.length - 1
      ];

    if (
      oldLast.time !==
      newLast.time
    ) {

      marketEvents.emit(
        "new-candle",
        {
          key,
          candle: newLast
        }
      );
    }
  }

  getCandles(
    symbol: string,
    timeframe: string
  ) {

    return this.cache.get(
      `${symbol}_${timeframe}`
    );
  }

  async syncSymbol(
    symbol: string
  ) {

    const timeframes = [
      "M1",
      "M5",
      "M15",
      "H1"
    ];

    for (const tf of timeframes) {
      await this.loadCandles(symbol, tf, 200);
    }

    // D1 needs ~1 year of history for reliable bias detection
    await this.loadCandles(symbol, "D1", 365);
  }

}

