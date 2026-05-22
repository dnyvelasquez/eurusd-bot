import { MSSEngine } from './strategy/mss/mss-engine';

const engine = new MSSEngine();

engine.on('bearishMSS', mss => {
  console.log('\nBEARISH MSS:\n');

  console.dir(mss, { depth: null });
});

engine.on('bullishMSS', mss => {
  console.log('\nBULLISH MSS:\n');

  console.dir(mss, { depth: null });
});

engine.analyzeBearishShift(
  {
    time: Date.now(),
    open: 7390,
    high: 7392,
    low: 7378,
    close: 7379,
  },
  {
    price: 7382,
    time: 1,
  },
);