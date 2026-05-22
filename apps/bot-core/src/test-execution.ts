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
  symbol: 'SPX500',

  side: 'SELL',

  volume: 1,

  entryPrice: 7480,

  stopLoss: 7500,

  takeProfit: 7440,
});