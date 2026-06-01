import { RiskEngine } from './strategy/risk/risk-engine';

const engine = new RiskEngine();

engine.on(
  'riskApproved',
  result => {
    console.log(
      '\nRISK APPROVED:\n',
    );

    console.dir(result, {
      depth: null,
    });
  },
);

engine.on(
  'setupRejected',
  result => {
    console.log(
      '\nSETUP REJECTED:\n',
    );

    console.dir(result, {
      depth: null,
    });
  },
);

engine.analyze({
  accountBalance: 10000,

  riskPercent: 1,

  entryPrice: 1.10000,

  stopLoss: 1.09900,

  target: 1.10200,

  tradeTickSize: 0.00001,

  tradeTickValue: 1.0,
});