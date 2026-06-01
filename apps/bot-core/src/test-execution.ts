import { ExecutionEngine } from './services/execution/execution-engine';

const engine =
  new ExecutionEngine();

engine.on(
  'positionOpened',
  result => {
    console.log(
      '\nPOSITION OPENED:\n',
    );

    console.dir(result, {
      depth: null,
    });
  },
);

engine.on(
  'executionFailed',
  result => {
    console.log(
      '\nEXECUTION FAILED:\n',
    );

    console.dir(result, {
      depth: null,
    });
  },
);

engine.execute({
  symbol: 'EURUSD',

  side: 'SELL',

  volume: 1,

  entryPrice: 1.10000,

  stopLoss: 1.10200,

  takeProfit: 1.09600,
});