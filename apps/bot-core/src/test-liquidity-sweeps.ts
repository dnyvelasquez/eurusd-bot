import { LiquidityEngine } from './strategy/liquidity/liquidity-engine';

const engine = new LiquidityEngine();

engine.on('clustersUpdated', clusters => {
  console.log('\nCLUSTERS:\n');
  console.dir(clusters, { depth: null });
});

engine.on('liquiditySweep', sweep => {
  console.log('\nSWEEP DETECTED:\n');
  console.dir(sweep, { depth: null });
});

engine.addLevels([
  {
    price: 7390.2,
    type: 'EQH',
    touches: 2,
    firstTouchTime: 1,
  },
  {
    price: 7390.8,
    type: 'EQH',
    touches: 3,
    firstTouchTime: 2,
  },
  {
    price: 7360.1,
    type: 'EQL',
    touches: 2,
    firstTouchTime: 3,
  },
]);

engine.analyzeCandle({
  time: Date.now(),
  open: 7388,
  high: 7393,
  low: 7384,
  close: 7387,
});