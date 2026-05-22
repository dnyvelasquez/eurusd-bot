import { FVGEngine } from './strategy/fvg/fvg-engine';

const engine = new FVGEngine();

engine.on(
  'displacement',
  displacement => {
    console.log(
      '\nDISPLACEMENT:\n',
    );

    console.dir(displacement, {
      depth: null,
    });
  },
);

engine.on('bullishFVG', fvg => {
  console.log('\nBULLISH FVG:\n');

  console.dir(fvg, {
    depth: null,
  });
});

engine.analyze([
  {
    time: 1,
    high: 7380,
    low: 7370,
  },
  {
    time: 2,
    high: 7395,
    low: 7378,
  },
  {
    time: 3,
    open: 7392,
    close: 7405,
    high: 7410,
    low: 7385,
  },
]);