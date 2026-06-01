import { MT5Service }
  from "./services/mt5/mt5.service";

import { TrendEngine }
  from "./strategy/structure/trend-engine";

async function main() {

  const mt5 =
    new MT5Service();

  const trendEngine =
    new TrendEngine();

  const response =
    await mt5.getCandles(
      "EURUSD",
      "M15",
      200
    );

  const trend =
    trendEngine.analyze(
      response.data
    );

  console.log(
    "\nTREND STATE:\n"
  );

  console.log(trend);
}

main();