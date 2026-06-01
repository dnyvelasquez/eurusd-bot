const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/eurusd-bot/backtest-EURUSD-2026-01-01-2026-05-26.json', 'utf-8'));
const trades = data.trades;

function weekLabel(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + 'T12:00:00Z');
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = dt => dt.toISOString().slice(5, 10);
  return fmt(monday) + ' -> ' + fmt(friday);
}

function weekKey(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + 'T12:00:00Z');
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startW1 = new Date(jan4);
  startW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const diff = (d - startW1) / 86400000;
  const week = Math.floor(diff / 7) + 1;
  return d.getFullYear() + '-W' + String(week).padStart(2, '0');
}

const weeks = {};
for (const t of trades) {
  if (t.result === 'OPEN') continue;
  const k = weekKey(t.openTimeISO);
  if (!weeks[k]) weeks[k] = { label: weekLabel(t.openTimeISO), key: k, trades: [] };
  weeks[k].trades.push(t);
}

const sortedWeeks = Object.values(weeks).sort((a, b) => a.key < b.key ? -1 : 1);
const completed = trades.filter(t => t.result !== 'OPEN');
const wins = completed.filter(t => t.result === 'WIN');
const losses = completed.filter(t => t.result === 'LOSS');
const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
const pf = grossLoss > 0 ? (grossProfit / grossLoss) : 999;
const zb = completed.filter(t => t.signalType === 'ZONE');
const ep = completed.filter(t => t.signalType === 'EMA_PB');

const SEP = '='.repeat(100);
const sep = '-'.repeat(100);

function statLine(label, ts) {
  const w = ts.filter(t => t.result === 'WIN').length;
  const l = ts.filter(t => t.result === 'LOSS').length;
  const pnl = ts.reduce((s, t) => s + t.pnl, 0);
  const wr = (w + l > 0) ? ((w / (w + l)) * 100).toFixed(1) : '-';
  const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
  return ' ' + label.padEnd(22) + ' Trades: ' + String(w + l).padStart(3) +
    '  W/L: ' + String(w).padStart(2) + '/' + String(l).padStart(2) +
    '  WR: ' + wr.padStart(5) + '%  PnL: $' + pnlStr.padStart(10);
}

const finalBalance = Math.round(data.finalBalance * 100) / 100;
const totalPnl = Math.round((data.finalBalance - data.initialBalance) * 100) / 100;
const retorno = ((totalPnl / data.initialBalance) * 100).toFixed(1);
const pnlSign = totalPnl >= 0 ? '+' : '';

console.log('\n' + SEP);
console.log(' EURUSD Bot -- Informe de Backtest | ' + data.from + ' -> ' + data.to);
console.log(' Config: Risk ' + data.riskPercent + '%  |  Cooldown ' + data.cooldownMinutes + ' min  |  EP_MIN_HOUR=3  |  EP_SKIP_MONDAY=false  |  EMA_SPREAD_MIN=0.0005  |  EP_MAX_HOUR=17');
console.log(' Balance: $' + data.initialBalance.toFixed(2) + ' -> $' + finalBalance.toFixed(2) + '   |  Total P&L: ' + pnlSign + '$' + totalPnl.toFixed(2) + '   |  Retorno: ' + pnlSign + retorno + '%');
console.log(SEP);

console.log('\n RESUMEN GLOBAL');
console.log(sep);
console.log(statLine('[ZB] Zone Bounce', zb));
console.log(statLine('[EP] EMA Pullback', ep));
console.log(sep);
const wrTotal = ((wins.length / completed.length) * 100).toFixed(1);
const totalPnlFmt = pnlSign + '$' + Math.abs(totalPnl).toFixed(2);
let maxDD = 0, peak = data.initialBalance, bal = data.initialBalance;
let maxConsec = 0, curConsec = 0;
for (const t of completed) {
  bal += t.pnl;
  if (bal > peak) peak = bal;
  const dd = ((peak - bal) / peak) * 100;
  if (dd > maxDD) maxDD = dd;
  if (t.result === 'LOSS') { curConsec++; if (curConsec > maxConsec) maxConsec = curConsec; }
  else curConsec = 0;
}
console.log(' ' + 'TOTAL'.padEnd(22) + ' Trades: ' + String(completed.length).padStart(3) +
  '  W/L: ' + wins.length + '/' + losses.length + '  WR: ' + wrTotal.padStart(5) + '%  PnL: ' + totalPnlFmt);
console.log(' Profit Factor: ' + pf.toFixed(2) + '   Avg R:R wins: +2.00   Avg R:R losses: -1.00   Max DD: ' + maxDD.toFixed(2) + '%   Max racha perdidas: ' + maxConsec);

const months = {};
for (const t of completed) {
  const m = t.openTimeISO.slice(0, 7);
  if (!months[m]) months[m] = { wins: 0, losses: 0, pnl: 0 };
  if (t.result === 'WIN') months[m].wins++;
  else months[m].losses++;
  months[m].pnl += t.pnl;
}
const monthNames = { '01': 'Enero', '02': 'Feb', '03': 'Marzo', '04': 'Abril', '05': 'Mayo' };

console.log('\n' + SEP);
console.log(' RESUMEN MENSUAL');
console.log(SEP);
console.log(' Mes             Trades    W     L     WR%      PnL ($)     Resultado');
console.log(sep);
for (const [k, d] of Object.entries(months).sort()) {
  const [yr, mo] = k.split('-');
  const total = d.wins + d.losses;
  const wr = ((d.wins / total) * 100).toFixed(1);
  const pnlStr = (d.pnl >= 0 ? '+' : '') + d.pnl.toFixed(2);
  const icon = d.pnl >= 0 ? '(+)' : '(-)';
  console.log(' ' + (monthNames[mo] + ' ' + yr).padEnd(15) +
    String(total).padStart(7) + String(d.wins).padStart(6) + String(d.losses).padStart(6) +
    wr.padStart(8) + '%' + pnlStr.padStart(13) + '     ' + icon);
}

console.log('\n' + SEP);
console.log(' PERFORMANCE SEMANAL');
console.log(SEP);
console.log(' Semana       Rango              Trades   W    L    WR%      PnL ($)    Mix signals    Acum. ($)');
console.log(sep);

let cumPnl = 0;
let bestPnl = -Infinity, worstPnl = Infinity, bestWeek = '', worstWeek = '';
const weekPositive = [], weekNegative = [];

for (const w of sortedWeeks) {
  const ts = w.trades;
  const ww = ts.filter(t => t.result === 'WIN').length;
  const ll = ts.filter(t => t.result === 'LOSS').length;
  const pnl = ts.reduce((s, t) => s + t.pnl, 0);
  cumPnl += pnl;
  if (pnl >= 0) weekPositive.push(w.key);
  else weekNegative.push(w.key);
  if (pnl > bestPnl) { bestPnl = pnl; bestWeek = w.label; }
  if (pnl < worstPnl) { worstPnl = pnl; worstWeek = w.label; }
  const total = ww + ll;
  const wr = total > 0 ? ((ww / total) * 100).toFixed(1) : '-';
  const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
  const cumStr = (cumPnl >= 0 ? '+' : '') + cumPnl.toFixed(2);
  const zbN = ts.filter(t => t.signalType === 'ZONE').length;
  const epN = ts.filter(t => t.signalType === 'EMA_PB').length;
  const mix = (zbN > 0 ? 'ZB:' + zbN + ' ' : '') + (epN > 0 ? 'EP:' + epN : '');
  const icon = pnl >= 0 ? '(+)' : '(-)';
  console.log(' ' + w.key.padEnd(12) + w.label.padEnd(17) +
    String(total).padStart(6) + String(ww).padStart(5) + String(ll).padStart(5) +
    wr.padStart(7) + '%' + pnlStr.padStart(11) + '   ' + mix.padEnd(12) + cumStr.padStart(11) + '  ' + icon);
}

console.log(sep);
console.log(' Semanas analizadas: ' + sortedWeeks.length +
  '   Positivas: ' + weekPositive.length +
  '   Negativas: ' + weekNegative.length +
  '   Hit rate semanal: ' + ((weekPositive.length / sortedWeeks.length) * 100).toFixed(1) + '%');
console.log(' Mejor semana:  ' + bestWeek + '  P&L: +' + bestPnl.toFixed(2));
console.log(' Peor semana:   ' + worstWeek + '  P&L: ' + worstPnl.toFixed(2));

console.log('\n' + SEP);
console.log(' DETALLE SEMANAL -- TRADES');
console.log(SEP);

for (const w of sortedWeeks) {
  const ts = w.trades;
  const ww = ts.filter(t => t.result === 'WIN').length;
  const ll = ts.filter(t => t.result === 'LOSS').length;
  const pnl = ts.reduce((s, t) => s + t.pnl, 0);
  const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
  const wr = ts.length > 0 ? ((ww / ts.length) * 100).toFixed(0) : '-';
  const icon = pnl >= 0 ? '(+)' : '(-)';
  console.log('\n ' + icon + ' ' + w.key + '  ' + w.label + '   W/L: ' + ww + '/' + ll + '  WR: ' + wr + '%  PnL: ' + pnlStr);
  console.log('   ' + '-'.repeat(95));
  console.log('   Apertura (ET)       Tipo   Dir    Entry       SL         TP        R:R    Resultado   PnL ($)');
  for (const t of ts) {
    const res = t.result === 'WIN' ? 'WIN ' : 'LOSS';
    const tag = t.signalType === 'ZONE' ? '[ZB]' : t.signalType === 'EMA_PB' ? '[EP]' : '[BP]';
    const tpnl = (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2);
    const rr = t.actualRr !== null ? String(t.actualRr) : 'n/a';
    console.log('   ' + t.openTimeISO + '  ' + tag + '   ' + t.side.padEnd(5) +
      String(t.entry.toFixed(2)).padStart(9) + '  ' + String(t.sl.toFixed(2)).padStart(9) +
      '  ' + String(t.tp.toFixed(2)).padStart(9) + '  ' + rr.padStart(5) +
      '   ' + res + '   ' + tpnl.padStart(9));
  }
}

console.log('\n' + SEP + '\n');
