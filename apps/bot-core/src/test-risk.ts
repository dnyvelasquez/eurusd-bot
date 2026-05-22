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

  entryPrice: 7390,

  stopLoss: 7400,

  target: 7360,
});