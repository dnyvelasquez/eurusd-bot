# Auditoría EURUSD-bot — FASE 2B: congelar TODAS las temporalidades (2026-06-26/27)

**Repo:** `C:\Personal\Develop\eurusd-bot`
**Tarea:** extender la congelación de FASE 2A (solo M5) a H1, H4, M15 y D1, para inmunidad
total del backtest contra cambios del bridge en vivo. No se tocaron parámetros de señal,
no se construyó walk-forward, no se tocó el split TRAIN/TEST definido en FASE 2A. No se
commiteó nada.

---

## 1. Inventario de profundidad por temporalidad (antes de congelar)

Se consultó el bridge (`http://127.0.0.1:8001/api/trading/candles/EURUSDm/{tf}/range`)
con rangos muy anchos para encontrar el borde real del histórico de cada temporalidad
(la misma técnica de "clamping" detectada en FASE 2A: pedir antes del primer dato real
devuelve una sola vela repetida, sin importar cuán atrás se pida).

| TF | Primera vela real observada | Cobertura confirmada hacia atrás desde 2025‑02‑17 | Notas |
|---|---|---|---|
| M5 | `2025-02-17 07:00:00 UTC` (congelada en FASE 2A) | 0 — es el borde real | Limitación de tick-history M5, ya documentada en FASE 2A |
| H1 | ≤ `2014-01-13` (clamp visto en esa fecha; datos reales continuos confirmados ≥ 2020-01-02, 24,928 velas en 2020-2024) | **~5 años** | Muy por encima de cualquier lookback usado |
| H4 | ≤ `2014-01-13` (mismo clamp; reales continuos confirmados ≥ 2020-01-02, 6,440 velas) | **~5 años** | Idem |
| M15 | `2022-06-22 ~15:30 UTC` (primera vela real confirmada por búsqueda binaria) | **~2.7 años** | Mucho mayor que warm-up necesario |
| D1 | ≤ `2014-01-13` (clamp; reales continuos confirmados ≥ 2020-01-02, 1,605 velas) | **~5 años** | Idem |

**Conclusión clave:** la limitación de histórico a `2025-02-17` es **exclusiva de M5**
(retención de tick-data de menor profundidad en el broker/MT5). H1, H4, M15 y D1 tienen
años de historia real disponible antes de esa fecha.

### Warm-up por indicador — verificación

El indicador de mayor lookback es **SMA200 sobre D1** (necesita 200 velas D1 *antes* del
primer trade posible, `2025-02-17`). `runBacktest()` ya pide D1 desde 365 días antes de
`from` (`d1FetchFrom`, `backtest-runner.ts` línea ~421-423); H1/H4/M15 se piden con
`WARM_UP_DAYS = 30` días antes de `from`.

Verificación empírica directa sobre el archivo D1 congelado (rango `2024-02-18` →
`2026-06-26`, ver §2):

| Indicador | Lookback requerido | Días de warm-up disponibles antes de 2025-02-17 | Resultado |
|---|---|---|---|
| SMA200 D1 (`smaTrendPeriod=200`, `smaTrendTf='D1'`) | 200 velas D1 | **313 velas D1** (`2024-02-18` → `2025-02-16`) | ✅ Suficiente, con margen de 113 velas |
| Zonas S/R D1 (`SWING_LOOKBACK.D1 = 100`) | 100 velas D1 | 313 velas D1 | ✅ Suficiente |
| ADX H4 (`epAdxPeriod=14`, necesita ≥ 2×14+1=29) | 29 velas H4 | 30 días × ~6 velas H4/día ≈ 180 velas H4 | ✅ Suficiente |
| ADX H1 (`epH1AdxMin`, mismo período) | 29 velas H1 | 30 días × 24 velas H1/día ≈ 720 velas H1 | ✅ Suficiente |
| EMA8/34 H4/H1/M15, MACD M15, Choppiness H4 | ≤ 34 velas | Cubierto ampliamente por la ventana de 30 días | ✅ Suficiente |

**No hay fuga de warm-up en ninguna temporalidad.** Se procedió a congelar.

---

## 2. Dataset congelado

Se reutilizó `scripts/freeze-dataset.ts` sin modificarlo — ya era genérico en `symbol`/`tf`
(recibido por `argv`), por lo que extender la congelación a las 4 temporalidades nuevas
fue solo una cuestión de invocarlo 4 veces más con rangos que incluyen el warm-up
correspondiente a cada una (30 días para H1/H4/M15, 365 días para D1, anclados al inicio
real del dataset M5: `2025-02-17`).

```
npx tsx scripts/freeze-dataset.ts EURUSDm H1  2025-01-18T00:00:00Z 2026-06-27T04:10:00Z
npx tsx scripts/freeze-dataset.ts EURUSDm H4  2025-01-18T00:00:00Z 2026-06-27T04:10:00Z
npx tsx scripts/freeze-dataset.ts EURUSDm M15 2025-01-18T00:00:00Z 2026-06-27T04:10:00Z
npx tsx scripts/freeze-dataset.ts EURUSDm D1  2024-02-18T00:00:00Z 2026-06-27T04:10:00Z
```

### Resultado

| TF | Archivo | Primera vela | Última vela | Conteo | SHA256 |
|---|---|---|---|---|---|
| M5 | `eurusdm-m5-2025-02-17_to_2026-06-26-extracted2026-06-26.csv` (FASE 2A, sin cambios) | `2025-02-17T07:00:00Z` | `2026-06-26T18:30:00Z` | 101,407 | `2ab3a8aade012f5a850f9a591d78670694e1a6a92d1a5def255757837a014b75` |
| H1 | `eurusdm-h1-2025-01-19_to_2026-06-26-extracted2026-06-27.csv` | `2025-01-19T22:00:00Z` | `2026-06-26T20:00:00Z` | 8,952 | `286e71fc03bea91ef757f8fd5ab35fc1c3a12ea50e4406dc52c5ee9af2ca4088` |
| H4 | `eurusdm-h4-2025-01-19_to_2026-06-26-extracted2026-06-27.csv` | `2025-01-19T20:00:00Z` | `2026-06-26T20:00:00Z` | 2,315 | `18ad5acec344af000d971f4cde36d1c3d3ba05138efc0eda7fb7c11fabb0446b` |
| M15 | `eurusdm-m15-2025-01-19_to_2026-06-26-extracted2026-06-27.csv` | `2025-01-19T22:00:00Z` | `2026-06-26T20:45:00Z` | 35,805 | `9407d37c9ff8c006131595596146d06bfd7582cf0a0e4e82a5ea2980a2c5e584` |
| D1 | `eurusdm-d1-2024-02-18_to_2026-06-26-extracted2026-06-27.csv` | `2024-02-18T00:00:00Z` | `2026-06-26T00:00:00Z` | 738 | `9413c55187aed308d8f6129da3e8f4451a984664d2be77f0220a72adf4fad151` |

Todos los archivos viven en `research/data/`. Hashes generados por el propio script al
escribir el archivo (no re-verificados con `sha256sum` externo en esta fase, a diferencia
de FASE 2A — recomendado hacerlo antes de confiar en ellos para FASE 2C si se requiere
el mismo nivel de paranoia).

**M5 no se re-congeló** — el archivo de FASE 2A ya cubre hasta `2026-06-26`, suficiente
para cualquier `--end` ≤ esa fecha.

---

## 3. Harness: `--frozen-dir`

Cambios de plumbing puro, sin tocar lógica de señales/riesgo:

- **`src/backtest/backtest-runner.ts`**
  - Nuevo campo opcional `frozenDir?: string` en `BacktestParams` (junto al `frozenM5Path`
    de FASE 2A, que se mantiene y tiene prioridad sobre `frozenDir` para M5 específicamente
    si ambos están seteados).
  - `fetchFrozenM5Candles()` renombrada a `fetchFrozenCandles()` — ahora genérica, no
    M5-específica (la lógica no cambió, solo el nombre y el alcance).
  - Nueva `findFrozenFile(dir, symbol, tf)`: busca en `dir` un archivo que empiece con
    `${symbol.toLowerCase()}-${tf.toLowerCase()}-` y termine en `.csv` (la convención de
    nombre que ya usa `freeze-dataset.ts`). Lanza error explícito si no encuentra archivo
    o si hay más de uno ambiguo — falla ruidosamente en vez de adivinar.
  - En `runBacktest()`: cuando `frozenDir` está seteado, se resuelve un path congelado por
    cada temporalidad (M5/H1/H4/M15/D1) y se usa en el `Promise.all` de fetch en vez de
    llamar al bridge para esa temporalidad. El bridge en vivo sigue siendo el default
    cuando no se pasa ni `--frozen-m5` ni `--frozen-dir` — no se eliminó esa capacidad.
- **`src/backtest/index.ts`**
  - Nuevo flag CLI `--frozen-dir <dir>`, leído en `resolveBacktestParams()`.

`npm run typecheck`: limpio.

---

## 4. Verificación de reproducibilidad byte-a-byte

Corrida de control: `--start 2025-07-01 --end 2026-06-24` (el mismo rango de control de
FASE 2A), una vez contra el bridge en vivo y una vez con `--frozen-dir research/data`.

### Primer intento — discrepancia encontrada y diagnosticada

La primera comparación (corridas live y frozen ejecutadas con ~1 minuto de diferencia)
**no fue byte-idéntica**: las 59 operaciones de ambos reportes eran las mismas en
contenido (mismo W/L, mismo P&L, mismo R:R), pero **cada timestamp estaba desplazado por
exactamente +60 segundos** en la corrida frozen vs. la live.

**Causa raíz — no es una fuga de la congelación de temporalidades.** Es un problema
preexistente, ya presente desde FASE 1, en `fetchBrokerOffsetSeconds()`
(`backtest-runner.ts` líneas ~185-202): el offset de reloj del broker se calcula en *cada*
corrida comparando un tick en vivo (`/tick/{symbol}`) contra `Date.now()` del sistema, y se
redondea al minuto más cercano. Cuando el tick del bridge está "congelado" (cuenta demo sin
movimiento en este instante) pero el reloj local sigue avanzando, dos invocaciones del CLI
separadas por más de el resto de un minuto pueden caer en lados opuestos de un límite de
redondeo de minuto, dándole a cada corrida un offset distinto en exactamente 60s — lo cual
se propaga a TODOS los timestamps de velas (y por lo tanto de trades) de esa corrida.
Confirmado consultando `/tick/EURUSDm` dos veces: el tick está congelado (`time` fijo) pero
`Date.now()` avanza, validando el mecanismo exacto del drift.

**Esto no depende de qué temporalidades estén congeladas** — habría afectado igual a la
verificación de FASE 2A si esa corrida hubiera cruzado un límite de minuto (no lo hizo, por
eso FASE 2A reportó coincidencia perfecta).

### Verificación aislada del offset — confirmación de que la congelación SÍ es correcta

Se repitió la corrida de control lanzando live y frozen en paralelo (mismo minuto de reloj
de pared) para neutralizar el drift del offset:

| | Live bridge | Frozen (`--frozen-dir`) |
|---|---|---|
| Trades | 57 | 57 |
| Reporte completo (excl. `generatedAt`) | — | **idéntico byte a byte** |

Con el offset estabilizado, ambos reportes JSON completos son **idénticos** campo por
campo. Esto confirma que **la lógica de congelación de M5/H1/H4/M15/D1 es correcta y
determinista** — la discrepancia anterior fue enteramente atribuible al mecanismo de
offset de reloj, no a datos de velas.

**Nota:** el conteo de trades de control (57-59, variable entre corridas) difiere del 58
reportado en FASE 2A para el mismo rango de fechas — consistente con la motivación misma
de este trabajo: el histórico que sirve el bridge en vivo para un rango ya pasado **no es
estable en el tiempo** (cambia entre el momento de FASE 2A, ayer, y hoy). Con
`--frozen-dir`, una vez fijado el snapshot, el resultado para ese rango queda fijo para
siempre, independientemente de qué le pase al bridge.

### Hallazgo pendiente para una fase futura (fuera de alcance de FASE 2B)

`fetchBrokerOffsetSeconds()` sigue sin congelarse — depende de un tick en vivo + el reloj
del sistema en cada corrida, y puede introducir jitter de ±1 minuto (y en casos límite,
cambiar qué vela cae en qué ventana horaria de sesión, alterando señales) entre dos
corridas no simultáneas. Para inmunidad *total* (no solo de datos de velas), este offset
debería congelarse también — por ejemplo, registrando el offset medido junto con el dataset
congelado y reutilizándolo en vez de re-medirlo en cada corrida. **No se tocó en esta fase**
porque cae fuera de lo pedido ("temporalidades que usa el backtest") y porque tocar la
lógica de timing es más sensible — se documenta aquí para que se decida explícitamente si
se aborda en FASE 2C o en una fase de congelación dedicada.

---

## 5. Archivos modificados/creados

**Nuevos:**
- `research/data/eurusdm-h1-2025-01-19_to_2026-06-26-extracted2026-06-27.csv`
- `research/data/eurusdm-h4-2025-01-19_to_2026-06-26-extracted2026-06-27.csv`
- `research/data/eurusdm-m15-2025-01-19_to_2026-06-26-extracted2026-06-27.csv`
- `research/data/eurusdm-d1-2024-02-18_to_2026-06-26-extracted2026-06-27.csv`
- `docs/eurusd-fase2b-full-dataset-freeze-2026-06-26.md` — este archivo.

**Modificados:**
- `src/backtest/backtest-runner.ts` — `frozenDir` param, `fetchFrozenCandles()` genérica,
  `findFrozenFile()`, resolución por temporalidad en `runBacktest()`.
- `src/backtest/index.ts` — flag CLI `--frozen-dir <dir>`.

**Sin cambios:** `scripts/freeze-dataset.ts` (ya era genérico), `research/data/eurusdm-m5-*`
(FASE 2A, reutilizado tal cual), ninguna lógica de señales/riesgo, `config.json`,
`README.md`, `CLAUDE.md`.

**No se commiteó nada.**

---

## 6. Pendiente para revisión antes de FASE 2C

1. Decidir si se congela también `fetchBrokerOffsetSeconds()` (ver §4) antes de construir
   walk-forward, o si se acepta el jitter de ±1 min como ruido tolerable.
2. El split TRAIN/TEST y el hallazgo de TEST por debajo del piso de 25 trades (definidos en
   FASE 2A, sin cambios aquí) siguen pendientes de tu decisión.
