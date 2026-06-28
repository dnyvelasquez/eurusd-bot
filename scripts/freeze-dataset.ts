import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';

// One-off extraction utility for FASE 2A (dataset freeze). Pulls the COMPLETE available
// M5 history for a symbol from the live MT5 bridge and writes it to a versioned CSV under
// research/data/, so that all future backtest measurements can read from a fixed file
// instead of the live bridge (whose history can change between runs). Not part of the
// regular backtest/live code paths — run manually, once, when (re-)freezing the dataset.

const BRIDGE_URL = 'http://127.0.0.1:8001/api/trading';
const CHUNK_DAYS = 60; // same window size backtest-runner.ts uses — MT5's copy_rates_range
                        // silently drops data for wider single-shot ranges on M5.

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
}

async function fetchChunk(symbol: string, tf: string, from: string, to: string): Promise<Candle[]> {
  const url = `${BRIDGE_URL}/candles/${symbol}/${tf}/range`;
  const resp = await axios.get<{ success: boolean; data: Candle[] | null; message?: string }>(url, {
    params: { from_date: from, to_date: to },
    timeout: 120_000,
  });
  if (!resp.data.success) throw new Error(`Fetch failed: ${resp.data.message ?? 'unknown error'}`);
  return resp.data.data ?? [];
}

async function fetchFullHistory(symbol: string, tf: string, fromIso: string, toIso: string): Promise<Candle[]> {
  const fromDate = new Date(fromIso);
  const toDate = new Date(toIso);
  const all: Candle[] = [];
  let chunkStart = new Date(fromDate);
  while (chunkStart < toDate) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_DAYS * 86_400_000, toDate.getTime()));
    const chunk = await fetchChunk(symbol, tf, chunkStart.toISOString(), chunkEnd.toISOString());
    console.log(`  ${chunkStart.toISOString().slice(0, 10)} -> ${chunkEnd.toISOString().slice(0, 10)}: ${chunk.length} candles`);
    all.push(...chunk);
    chunkStart = chunkEnd;
  }
  const seen = new Set<number>();
  const deduped = all.filter(c => (seen.has(c.time) ? false : (seen.add(c.time), true)));
  deduped.sort((a, b) => a.time - b.time);
  return deduped;
}

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? 'EURUSDm';
  const tf = process.argv[3] ?? 'M5';
  const fromIso = process.argv[4]; // e.g. 2025-02-17T07:00:00Z
  const toIso = process.argv[5];   // e.g. 2026-06-26T16:25:00Z

  if (!fromIso || !toIso) {
    console.error('Uso: tsx scripts/freeze-dataset.ts <symbol> <tf> <fromIso> <toIso>');
    process.exit(1);
  }

  console.log(`Fetching ${symbol} ${tf} from ${fromIso} to ${toIso}...`);
  const candles = await fetchFullHistory(symbol, tf, fromIso, toIso);

  if (candles.length === 0) {
    console.error('No candles returned — aborting, not writing an empty freeze file.');
    process.exit(1);
  }

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  console.log(`\nTotal: ${candles.length} candles`);
  console.log(`First: ${new Date(first.time * 1000).toISOString()} (epoch ${first.time})`);
  console.log(`Last:  ${new Date(last.time * 1000).toISOString()} (epoch ${last.time})`);

  const extractDate = new Date().toISOString().slice(0, 10);
  const rangeTag = `${new Date(first.time * 1000).toISOString().slice(0, 10)}_to_${new Date(last.time * 1000).toISOString().slice(0, 10)}`;
  const outDir = path.resolve(__dirname, '..', 'research', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${symbol.toLowerCase()}-${tf.toLowerCase()}-${rangeTag}-extracted${extractDate}.csv`);

  const header = 'time,open,high,low,close,tick_volume\n';
  const rows = candles.map(c => `${c.time},${c.open},${c.high},${c.low},${c.close},${c.tick_volume}`).join('\n');
  fs.writeFileSync(outFile, header + rows + '\n', 'utf-8');

  const hash = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');

  console.log(`\nEscrito: ${outFile}`);
  console.log(`SHA256: ${hash}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
