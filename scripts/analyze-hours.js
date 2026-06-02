// Analiza trades por hora ET y muestra win rate, P&L y conteo por hora
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Uso: node analyze-hours.js backtest-*.json [backtest-*.json ...]');
  process.exit(1);
}

const allTrades = [];
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.resolve(f), 'utf-8'));
  allTrades.push(...(data.trades ?? []));
}

// Group by ET hour
const byHour = {};
for (const t of allTrades) {
  if (t.result === 'OPEN') continue;
  // openTimeISO is "YYYY-MM-DD HH:MM" in ET
  const hour = parseInt(t.openTimeISO.slice(11, 13), 10);
  if (!byHour[hour]) byHour[hour] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
  byHour[hour].trades++;
  byHour[hour].pnl += t.pnl;
  if (t.result === 'WIN') byHour[hour].wins++;
  else byHour[hour].losses++;
}

const SEP = '─'.repeat(60);
console.log('\n══════════════════════════════════════════════════════════');
console.log(' Análisis por hora ET — ' + files.join(', '));
console.log('══════════════════════════════════════════════════════════');
console.log(' Hora ET   Trades   W    L    WR%     P&L $    Señal');
console.log(SEP);

const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
for (const h of hours) {
  const s = byHour[h];
  const wr = ((s.wins / (s.wins + s.losses)) * 100).toFixed(0);
  const pnl = (s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(2);
  const label = h >= 3 && h < 8 ? 'London' :
                h >= 8 && h < 12 ? 'London+NY' :
                h >= 12 && h < 17 ? 'NY' : '';
  const flag = s.pnl < -20 ? ' ⚠' : '';
  const hStr = String(h).padStart(2, '0') + ':00';
  console.log(
    ` ${hStr}      ${String(s.trades).padStart(4)}  ${String(s.wins).padStart(3)}  ${String(s.losses).padStart(3)}` +
    `   ${wr.padStart(4)}%  ${pnl.padStart(9)}   ${label}${flag}`
  );
}

console.log(SEP);

// Best and worst hours
const ranked = hours
  .filter(h => byHour[h].trades >= 3)
  .sort((a, b) => byHour[b].pnl - byHour[a].pnl);

console.log('\n  Mejores horas (≥3 trades):');
for (const h of ranked.slice(0, 3)) {
  const s = byHour[h];
  const wr = ((s.wins / (s.wins + s.losses)) * 100).toFixed(0);
  console.log(`    ${String(h).padStart(2,'0')}:00 ET — ${s.trades} trades, WR ${wr}%, P&L ${(s.pnl >= 0?'+':'') + s.pnl.toFixed(2)}`);
}

console.log('\n  Peores horas (≥3 trades):');
for (const h of ranked.slice(-3).reverse()) {
  const s = byHour[h];
  const wr = ((s.wins / (s.wins + s.losses)) * 100).toFixed(0);
  console.log(`    ${String(h).padStart(2,'0')}:00 ET — ${s.trades} trades, WR ${wr}%, P&L ${(s.pnl >= 0?'+':'') + s.pnl.toFixed(2)}`);
}
console.log();
