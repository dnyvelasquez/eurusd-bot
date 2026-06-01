import { MT5Service }
  from "./services/mt5/mt5.service";

import { StructureEngine }
  from "./strategy/structure/structure-engine";

async function main() {

  const mt5 =
    new MT5Service();

  const structure =
    new StructureEngine();

  const response =
    await mt5.getCandles(
      "EURUSD",
      "M5",
      150
    );

  const result =
    structure.analyze(
      response.data
    );

  console.log(
    "\nSTRUCTURE:\n"
  );

  console.log(result);
}

main();