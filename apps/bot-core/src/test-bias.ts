import { MT5Service }
  from "./services/mt5/mt5.service";

import { BiasEngine }
  from "./strategy/bias/bias-engine";

async function main() {

  const mt5 =
    new MT5Service();

  const biasEngine =
    new BiasEngine();

  const response =
    await mt5.getCandles(
      "EURUSD",
      "H1",
      200
    );

  const bias =
    biasEngine.analyze(
      response.data
    );

  console.log(
    "\nHTF BIAS:\n"
  );

  console.log(bias);
}

main();