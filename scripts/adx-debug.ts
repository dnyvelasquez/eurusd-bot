import axios from 'axios';
import { ADXEngine } from '@bot-core/strategy/indicators/adx-engine';
import type { Candle } from '@bot-core/services/mt5/mt5.types';

async function main() {
  const adxEngine = new ADXEngine();
  const [r1, r4] = await Promise.all([
    axios.get<{ success: boolean; data: Candle[] }>(
      'http://127.0.0.1:8000/api/trading/candles/EURUSD/H1/range',
      { params: { from_date: '2026-01-01', to_date: '2026-03-01' }, timeout: 30000 },
    ),
    axios.get<{ success: boolean; data: Candle[] }>(
      'http://127.0.0.1:8000/api/trading/candles/EURUSD/H4/range',
      { params: { from_date: '2025-10-01', to_date: '2026-03-01' }, timeout: 30000 },
    ),
  ]);
  const h1 = r1.data.data;
  const h4 = r4.data.data;

  const checkDates: Array<{ date: string; label: string }> = [
    { date: '2026-02-03', label: 'EP BUY  LOSS' },
    { date: '2026-02-05', label: 'EP SELL WIN ' },
    { date: '2026-02-10', label: 'EP BUY  LOSS' },
    { date: '2026-02-13', label: 'EP SELL LOSS' },
    { date: '2026-02-17', label: 'EP SELL LOSS' },
    { date: '2026-02-20', label: 'ZB BUY  LOSS' },
    { date: '2026-02-25', label: 'EP BUY  WIN ' },
    { date: '2026-02-26', label: 'EP BUY  LOSS' },
    { date: '2026-02-27', label: 'EP SELL WIN ' },
  ];

  console.log('Date         H1-ADX   H4-ADX   Signal       Result');
  console.log('------------ -------- -------- ------------ ------');
  for (const { date, label } of checkDates) {
    const ts = new Date(date + 'T15:00:00Z').getTime() / 1000;
    const sliceH1 = h1.filter(c => c.time <= ts);
    const sliceH4 = h4.filter(c => c.time <= ts);
    const adxH1 = adxEngine.last(sliceH1, 14);
    const adxH4 = adxEngine.last(sliceH4, 14);
    const h1Str = adxH1 !== null ? adxH1.toFixed(1).padStart(6) : '  null';
    const h4Str = adxH4 !== null ? adxH4.toFixed(1).padStart(6) : '  null';
    console.log(date + '   ' + h1Str + '   ' + h4Str + '   ' + label);
  }

  console.log('\n--- Semanas positivas de referencia ---');
  const refDates: Array<{ date: string; label: string }> = [
    { date: '2026-02-04', label: 'W06 EP SELL WIN (ADX?)' },
    { date: '2026-03-04', label: 'W10 ZB BUY  WIN (best)' },
    { date: '2026-04-14', label: 'W16 EP BUY  WIN        ' },
    { date: '2026-05-06', label: 'W19 EP BUY  WIN        ' },
  ];
  for (const { date, label } of refDates) {
    const ts = new Date(date + 'T15:00:00Z').getTime() / 1000;
    const sliceH1 = h1.filter(c => c.time <= ts);
    const sliceH4 = h4.filter(c => c.time <= ts);
    const adxH1 = adxEngine.last(sliceH1, 14);
    const adxH4 = adxEngine.last(sliceH4, 14);
    console.log(date + '   H1:' + (adxH1?.toFixed(1) ?? 'null').padStart(5) + '   H4:' + (adxH4?.toFixed(1) ?? 'null').padStart(5) + '   ' + label);
  }
}

main().catch(console.error);
