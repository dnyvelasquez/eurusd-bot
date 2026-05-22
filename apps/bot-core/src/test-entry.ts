import { EntryEngine } from './strategy/entry/entry-engine';

const engine = new EntryEngine();

engine.on(
  'tradeSetup',
  setup => {
    console.log(
      '\nTRADE SETUP:\n',
    );

    console.dir(setup, {
      depth: null,
    });
  },
);

engine.analyze({
  htfBias: 'BEARISH',

  sweepDirection: 'BEARISH',

  mssDirection: 'BEARISH',

  hasDisplacement: true,

  hasFVG: true,

  entryPrice: 7390,

  stopLoss: 7402,

  target: 7360,
});