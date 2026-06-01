import { MT5Service }
  from "./services/mt5/mt5.service";

import { SwingDetector }
  from "./strategy/structure/swing-detector";

async function main() {

  const mt5 =
    new MT5Service();

  const swings =
    new SwingDetector();

  const response =
    await mt5.getCandles(
      "EURUSD",
      "M5",
      100
    );

  const result =
    swings.detectSwings(
      response.data
    );

  console.log(
    "\nSWINGS:\n"
  );

  console.log(result);
}

main();