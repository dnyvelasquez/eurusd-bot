import { MT5Service }
  from "./services/mt5/mt5.service";

import { LiquidityEngine }
  from "./strategy/liquidity/liquidity-engine";

async function main() {

  const mt5 =
    new MT5Service();

  const liquidity =
    new LiquidityEngine();

  const response =
    await mt5.getCandles(
      "EURUSD",
      "M15",
      100
    );

  const levels =
    liquidity.detectLiquidity(
      response.data
    );

  console.log(
    "\nLIQUIDITY LEVELS:\n"
  );

  console.log(levels);
}

main();