import { MT5Service }
  from "./services/mt5/mt5.service";

import { SwingDetector }
  from "./strategy/structure/swing-detector";

import { BOSDetector }
  from "./strategy/structure/bos-detector";

async function main() {

  const mt5 =
    new MT5Service();

  const swingDetector =
    new SwingDetector();

  const bosDetector =
    new BOSDetector();

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

  const bos =
    bosDetector.detectBos(
      response.data,
      swings
    );

  console.log(
    "\nBOS EVENTS:\n"
  );

  console.log(bos);
}

main();