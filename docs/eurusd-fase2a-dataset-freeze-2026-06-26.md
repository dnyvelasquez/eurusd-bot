# Auditoría EURUSD-bot — FASE 2A: congelar dataset + definir split train/test (2026-06-26)

**Repo:** `C:\Personal\Develop\eurusd-bot`
**Tarea:** congelar el histórico M5 de `EURUSDm` a un archivo versionado, dar al harness
de backtest la opción de leer de ese archivo en vez del bridge MT5 en vivo, y **definir**
(sin correr) un split temporal train/test sellado. No se tocaron parámetros de señal, no
se corrió ninguna optimización, no se tocó el TEST, no se commiteó nada.

---

## 1. Hallazgo previo a todo lo demás: el histórico real es mucho más corto de lo asumido

Antes de congelar nada, se necesitaba saber cuánto histórico M5 existe realmente para
`EURUSDm` en este bridge/cuenta. Resultado:

- **Primera vela M5 disponible: `2025-02-17 07:00:00 UTC`.** Cualquier rango solicitado
  con `from_date` anterior a esa fecha (probado contra 2000, 2010, 2018, 2020, 2023, y
  contra `2024-12-02` — la fecha que FASE 1 había usado como "warm-up" sin darse cuenta)
  devuelve **una sola vela**, siempre la misma (`time=1739775600`), sin importar cuán
  atrás se pida. Esto no es un bug del bridge: es el comportamiento de
  `mt5.copy_rates_range` cuando el rango pedido cae antes del histórico real — clampa al
  borde. Se confirmó narrowing el rango hasta una ventana de 4h alrededor de esa vela: el
  dato no se mueve.
- **Última vela disponible:** prácticamente "ahora" (`2026-06-26 18:30:00 UTC` al momento
  de la extracción) — la cuenta demo sigue corriendo en tiempo real.
- **Implicación para FASE 1:** los backtests de "2025 completo" y "jul-2025→jun-2026" ya
  medidos como deterministas en FASE 1 en realidad solo tenían datos reales desde
  17-feb-2025 — los ~6.5 semanas de enero/inicios de febrero 2025 estaban simplemente
  vacías (sin velas, no inventadas), lo cual no invalida el resultado determinista de
  FASE 1 pero explica por qué el conteo de trades medido (52) es menor al citado en el
  README de ese momento (54): el período real con datos es más corto que el nominal.
- **Implicación para el dataset disponible en general:** son solo **~16.4 meses** de
  historia real, no años. Esto limita directamente cuántos trades puede haber en
  cualquier split (ver §3).

---

## 2. Dataset congelado

### Extracción
Script nuevo (uso manual, no parte del path de backtest/live): `scripts/freeze-dataset.ts`.
Reutiliza el mismo patrón de chunking de 60 días que ya usa `backtest-runner.ts` (la
quirk conocida de MT5 de no devolver datos en rangos M5 muy anchos en una sola llamada),
pide cada chunk al bridge (`/candles/EURUSDm/M5/range`), de-duplica por timestamp, ordena,
y escribe CSV.

```
npx tsx scripts/freeze-dataset.ts EURUSDm M5 2025-02-17T00:00:00Z 2026-06-26T18:34:43Z
```

### Resultado

| Campo | Valor |
|---|---|
| Símbolo | `EURUSDm` |
| Timeframe | M5 |
| Primera vela | `2025-02-17T07:00:00Z` (epoch `1739775600`) |
| Última vela | `2026-06-26T18:30:00Z` (epoch `1782498600`) |
| Conteo total | **101,407 velas** |
| Archivo | `research/data/eurusdm-m5-2025-02-17_to_2026-06-26-extracted2026-06-26.csv` |
| Tamaño | 4,940,020 bytes |
| **SHA256** | `2ab3a8aade012f5a850f9a591d78670694e1a6a92d1a5def255757837a014b75` |

Hash verificado de forma independiente con `sha256sum` sobre el archivo en disco (coincide
con el que imprimió el script de extracción). Cualquier corrida futura que use este
archivo puede (y debe) verificar este hash antes de confiar en el resultado.

**Importante — alcance de lo congelado:** solo se congeló **M5**. `runBacktest()` también
usa H1/H4/M15/D1 (sesgo HTF, alineación, ADX, filtro SMA200 D1) que siguen viniendo del
bridge en vivo. El backtest ya es determinista para M5 con esto, pero **no es 100%
inmune** a que el histórico de las otras temporalidades cambie en el bridge. Fuera de
alcance de esta fase (la tarea pidió explícitamente congelar M5); queda como nota para una
fase futura si se necesita inmunidad total.

### Modificación del harness

Cambios puramente de plumbing, sin tocar lógica de señales/riesgo:

- **`src/backtest/backtest-runner.ts`**
  - Nuevo campo opcional `frozenM5Path?: string` en `BacktestParams`.
  - Nuevas funciones `loadFrozenCandles()` / `fetchFrozenM5Candles()`: leen el CSV
    congelado, cachean en memoria, y filtran por rango de fechas con la misma semántica
    (`[from, to]` inclusive) que ya usaba `fetchCandles()` contra el bridge.
  - En `runBacktest()`: cuando `frozenM5Path` está seteado, M5 se lee del archivo en vez
    de llamar al bridge; H1/H4/M15/D1 y la medición de offset del broker siguen
    exactamente igual que antes (sin cambios). **No se eliminó la capacidad de usar el
    bridge en vivo** — es el default cuando no se pasa el flag.
- **`src/backtest/index.ts`**
  - Nuevo flag CLI `--frozen-m5 <path>`, leído en `resolveBacktestParams()`.
- **`scripts/freeze-dataset.ts`** (nuevo) — utilidad de extracción, descrita arriba.

### Verificación: ¿el dataset congelado reproduce el resultado del bridge en vivo HOY?

Corrida de control: `--start 2025-07-01 --end 2026-06-24` (mismo período ya verificado
determinista en FASE 1, 58 trades), una vez contra el bridge en vivo y una vez contra
`--frozen-m5 research/data/eurusdm-m5-2025-02-17_to_2026-06-26-extracted2026-06-26.csv`.

| | Live bridge | Frozen file |
|---|---|---|
| Trades | 58 | 58 |
| Win rate | 52.63% | 52.63% |
| Profit factor | 1.61 | 1.61 |
| Total P&L | +$865.82 | +$865.82 |
| Max drawdown | 2.57% | 2.57% |

**Diff trade-a-trade de los dos JSON de reporte completos (58 trades cada uno): idénticos
byte a byte** (excluyendo el campo `generatedAt`, que es solo metadata de timestamp de
generación del reporte, no de los datos). `npm run typecheck`: limpio.

---

## 3. Split temporal train/test — DEFINIDO, NO EJECUTADO

**No se corrió el backtest sobre TEST.** Lo que sigue es solo la definición del corte,
calculada sobre el dataset congelado (conteos exactos de velas, no estimados).

### Split 70/30 (el pedido por la tarea)

| | TRAIN | TEST |
|---|---|---|
| Desde | 2025-02-17 07:00 UTC | 2026-01-29 00:00 UTC |
| Hasta | 2026-01-29 00:00 UTC (excl.) | 2026-06-26 18:30 UTC |
| Velas M5 | 70,746 | 30,661 |
| % del total | 69.8% | 30.2% |
| Días calendario | ~346 | ~148 |
| Días de mercado (con ≥1 vela) | 298 | 128 |

Corte elegido (`2026-01-29 00:00 UTC`) da casi exactamente 70/30 por conteo de velas — no
es solo un corte temporal proporcional, se verificó contra los datos reales.

### Estimación de trades por lado — ⚠️ TEST por debajo del piso de 25

Frecuencia histórica observada en este mismo dataset (mediciones deterministas ya hechas
en FASE 1 y en esta fase, contra el mismo backtest/config):

| Período medido | Días reales con datos | Trades | Trades/semana |
|---|---|---|---|
| 2025 completo (real: 17-feb a 31-dic) | ~317 | 52 | 1.15 |
| jul-2025 → jun-2026 | ~358 | 58 | 1.13 |
| ene-jun 2026 parcial | ~176 | 27 | 1.07 |

La frecuencia medida (**~1.1-1.15/semana**) es más alta que el "~0.8-1/semana" asumido en
la tarea — uso ambas como banda para la estimación.

| Split (test%) | Corte | Días TRAIN | Días TEST | Trades TRAIN (est.) | Trades TEST (est.) |
|---|---|---|---|---|---|
| **70/30** (pedido) | 2026-01-29 | 346 | 148 | **40–57** | **17–24** |
| 65/35 | 2026-01-04 | 321 | 173 | 37–53 | 20–28 |
| 60/40 | 2025-12-10 | 297 | 198 | 34–49 | 23–32 |
| 50/50 | 2025-10-22 | 247 | 247 | 28–41 | 28–41 |

**El split 70/30 pedido deja TEST en ~17–24 trades estimados — por debajo del piso de 25
que se definió de antemano.** Incluso con la frecuencia más alta medida (1.15/semana,
extremo optimista de la banda), TEST llega a ~24, justo en el borde; con la frecuencia más
conservadora (0.8/semana) cae a ~17.

Causa de fondo, no del split en sí: el dataset total solo tiene ~16.4 meses de historia
real (§1) y la estrategia opera a ~1 trade/semana — con esa frecuencia, **ningún split
70/30 sobre este rango total puede dar tanto TRAIN grande como TEST con masa robusta
simultáneamente**. Subir la proporción de TEST (60/40 o 50/50, tabla arriba) saca a TEST
del rango de riesgo, pero a costa de menos datos en TRAIN para la re-derivación de
parámetros de FASE 2B.

**No se decidió ni se cambió el split.** Como se pidió: te lo reporto y me detengo aquí
para que lo revises antes de avanzar a FASE 2B.

---

## 4. Plan de FASE 2B (no iniciado)

Una vez se confirme (o ajuste) la proporción del split:

1. Re-derivar/validar los parámetros actuales de `config.json` **solo sobre TRAIN**
   (`--start 2025-02-17 --end <fecha de corte>`, usando `--frozen-m5` para que la
   medición no dependa del bridge en vivo).
2. Documentar criterios de éxito pre-registrados **antes** de mirar el resultado de TEST
   (consistente con la disciplina de portafolio de `CLAUDE.md`: sin re-tuneo sobre datos
   de medición).
3. TEST permanece sellado hasta que TRAIN cierre con un resultado estable — recién ahí se
   corre una sola vez sobre TEST, sin iterar después de verlo.
4. README/CLAUDE.md se actualizan solo cuando el número de validación cierre (no en esta
   fase intermedia).

---

## 5. Archivos modificados/creados

**Nuevos:**
- `research/data/eurusdm-m5-2025-02-17_to_2026-06-26-extracted2026-06-26.csv` — dataset
  congelado (101,407 velas M5, SHA256 arriba).
- `scripts/freeze-dataset.ts` — utilidad de extracción (manual, no parte del path normal
  de backtest/live).
- `docs/eurusd-fase2a-dataset-freeze-2026-06-26.md` — este archivo.

**Modificados:**
- `src/backtest/backtest-runner.ts` — flag `frozenM5Path` + lectura desde CSV congelado
  (M5 únicamente). Sin cambio de comportamiento cuando el flag no se usa.
- `src/backtest/index.ts` — flag CLI `--frozen-m5 <path>`.

**No se tocó:** ninguna lógica de señales (ZB/EP), ningún parámetro de `config.json`,
`README.md`, `CLAUDE.md`. No se commiteó nada. No se corrió backtest sobre el rango TEST
definido en §3.
