import { MarketDataService }
  from "./market-data/market-data.service";

import { marketEvents }
  from "./market-data/market-events";

async function main() {

  const market =
    new MarketDataService();

  marketEvents.on(
    "new-candle",
    (data) => {

      console.log(
        "\nNEW CANDLE:"
      );

      console.log(
        `${data.key} -> NEW CANDLE CLOSED`
      );

      console.log(data.candle);

    }
  );

  console.log(
    "Monitoring candles..."
  );

  setInterval(async () => {

    await market.syncSymbol(
      "EURUSD"
    );
    
  }, 5000);
}

main();