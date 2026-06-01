import { MT5Service }
  from "./services/mt5/mt5.service";

import { SwingDetector }
  from "./strategy/structure/swing-detector";

import { CHOCHDetector }
  from "./strategy/structure/choch-detector";

async function main() {

  const mt5 =
    new MT5Service();

  const swingDetector =
    new SwingDetector();

  const chochDetector =
    new CHOCHDetector();

  const response =
    await mt5.getCandles(
      "EURUSD",
      "M5",
      100
    );

  const swings =
    swingDetector.detectSwings(
      response.data
    );

  const choch =
    chochDetector.detectChoch(
      response.data,
      swings
    );

  console.log(
    "\nCHOCH EVENTS:\n"
  );

  console.log(choch);
}

main();