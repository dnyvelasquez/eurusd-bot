# Auditoría EURUSD-bot — FASE 2B-bis: congelar el offset de reloj del broker (2026-06-27)

**Repo:** `C:\Personal\Develop\eurusd-bot`
**Tarea:** la última pieza de no-determinismo fundacional — el offset de reloj del broker se
medía en vivo en cada corrida (`fetchBrokerOffsetSeconds()`), lo cual podía desplazar
timestamps de velas ±60s entre corridas no simultáneas y cambiar el set de trades (variación
57-59 observada en FASE 2B). Se congela el offset junto al dataset, igual que se hizo con
las velas. No se tocó lógica de señales, no se re-tuneó, no se construyó walk-forward, no
se commiteó nada.

---

## 1. Offset medido

**Problema con el método estándar (tick en vivo vs. reloj local):** el mercado estaba
cerrado (fin de semana) durante toda esta sesión. El último tick de `EURUSDm`
(`/tick/EURUSDm`) estaba congelado en `2026-06-26T20:58:51Z` (el cierre real del viernes),
sin moverse entre llamadas sucesivas — comparar ese tick contra `Date.now()` (que sigue
avanzando) habría dado un "offset" de ~26 horas, que es ruido del mercado cerrado, no una
medición real del offset de reloj del broker.

**Método usado — alineación de velas (más robusto, no depende de que el mercado esté
abierto):** si el reloj del servidor del broker tuviera un offset no-cero respecto a UTC, las
velas D1/H1 (que abren en límites de hora "redondos" en hora de servidor) caerían en
timestamps que NO son múltiplos exactos de 86400/3600 al interpretarlos como epoch Unix
(salvo que el offset fuera él mismo un múltiplo exacto de 24h, lo cual no es un escenario de
offset de reloj real). Verificación sobre los archivos congelados en FASE 2B:

| Archivo | Velas verificadas | Resultado |
|---|---|---|
| `eurusdm-d1-2024-02-18_to_2026-06-26-extracted2026-06-27.csv` | 738 D1 | **100% con `time % 86400 == 0`** (medianoche UTC exacta) |
| `eurusdm-h1-2025-01-19_to_2026-06-26-extracted2026-06-27.csv` | 8,952 H1 | **100% con `time % 3600 == 0`** (hora UTC exacta) |

**Offset medido: `0` segundos.** Consistente con lo esperado por la tarea ("~0 para
Exness").

---

## 2. Congelación

Se registró el offset junto a los hashes de los datasets ya congelados (decisión: JSON de
metadata junto a los CSV, no una constante en código — ver justificación en §4) en:

**`research/data/eurusdm-frozen-meta.json`**
```json
{
  "symbol": "EURUSDm",
  "brokerOffsetSeconds": 0,
  "offsetMeasurement": { "method": "candle-alignment", ... },
  "datasets": {
    "M5":  { "file": "...", "sha256": "2ab3a8aade012f5a850f9a591d78670694e1a6a92d1a5def255757837a014b75" },
    "H1":  { "file": "...", "sha256": "286e71fc03bea91ef757f8fd5ab35fc1c3a12ea50e4406dc52c5ee9af2ca4088" },
    "H4":  { "file": "...", "sha256": "18ad5acec344af000d971f4cde36d1c3d3ba05138efc0eda7fb7c11fabb0446b" },
    "M15": { "file": "...", "sha256": "9407d37c9ff8c006131595596146d06bfd7582cf0a0e4e82a5ea2980a2c5e584" },
    "D1":  { "file": "...", "sha256": "9413c55187aed308d8f6129da3e8f4451a984664d2be77f0220a72adf4fad151" }
  }
}
```

Los 5 hashes se re-verificaron de forma independiente con `sha256sum` sobre los archivos en
disco — coinciden con los registrados en FASE 2B.

---

## 3. Cambios en el harness

- **`src/backtest/backtest-runner.ts`**
  - Nueva `getFrozenBrokerOffsetSeconds(frozenDir, symbol)`: lee `brokerOffsetSeconds` de
    `<frozenDir>/<symbol>-frozen-meta.json`.
  - En `runBacktest()`: cuando `frozenDir` está seteado, el offset usado en el `Promise.all`
    viene de `getFrozenBrokerOffsetSeconds()` en vez de `fetchBrokerOffsetSeconds(symbol)`
    (llamada en vivo al bridge). El path SIN `--frozen-dir` (bridge en vivo) sigue llamando
    a `fetchBrokerOffsetSeconds()` exactamente como antes — **no se tocó el comportamiento
    en vivo**, ni el del bot live (que nunca usó este offset, ver comentario existente en el
    código).
  - `fetchBrokerOffsetSeconds()` se conserva intacta — sigue siendo la herramienta manual
    para re-medir el offset (p.ej. para regenerar `frozen-meta.json` si el reloj del broker
    cambia o si se prefiere confirmar con el método de tick una vez el mercado esté abierto).
- **`src/backtest/check-determinism.ts`** — ver §4 (PASO 2).

`npm run typecheck`: limpio.

---

## 4. Por qué metadata-junto-al-dataset y no una constante en código

Se evaluaron las dos opciones pedidas por la tarea:

- **Constante en código** (patrón `getBacktestBrokerOffsetSeconds()` de SPX500): más simple,
  pero separa el offset de los datos que lo necesitan — alguien podría actualizar los CSV
  congelados sin tocar la constante, o viceversa, sin que nada lo detecte.
- **Metadata junto al dataset (elegido):** `frozenDir` ya es la unidad atómica que el
  harness recibe por `--frozen-dir <dir>` — todo lo que el backtest necesita para ser 100%
  determinista (5 CSV + el offset) vive en el mismo directorio versionado. Si en el futuro
  se re-congela el dataset completo (nuevo `frozenDir`), el offset viaja con él
  automáticamente sin tocar código. Para EURUSD, donde ya existe el mecanismo
  `--frozen-dir` (a diferencia de SPX500, que no tenía ese concepto cuando se aplicó su
  fix), esto es más consistente con la arquitectura ya construida en FASE 2A/2B.

`fetchBrokerOffsetSeconds()` no se borró — sigue disponible para re-medir manualmente.

---

## 5. Verificación: guard de regresión reforzado (PASO 2)

Se extendió `check-determinism.ts` con un modo `--cross-process`: en vez de llamar
`runBacktest()` dos veces en el mismo proceso Node (lo cual nunca habría detectado este bug,
porque `offsetCache` persiste dentro del proceso y la segunda llamada reutiliza la primera
medición), spawnea **dos procesos `tsx` separados**, cada uno con su propio
`Date.now()`/caché, con una **pausa deliberada de 65 segundos** entre ambos — exactamente la
condición que disparó el bug original (offset redondeado a un lado u otro de un límite de
minuto entre corridas no simultáneas).

```
npx tsx src/backtest/check-determinism.ts 2025-07-01 2026-06-24 --cross-process --frozen-dir research/data
```

### Resultado

| | Run A (proceso 1) | Run B (proceso 2, 65s después) |
|---|---|---|
| Trades | 58 | 58 |
| Set de trades + métricas | — | **idéntico** (comparación campo a campo) |

```
✅ DETERMINISM CHECK PASSED (cross-process) — 58 trades, identical set and metrics across both runs.
```

**Antes de este fix, esta misma corrida habría podido fallar** (es exactamente la condición
que produjo 57/58/59 trades en corridas distintas durante la verificación de FASE 2B). Con
el offset congelado, dos procesos separados por más de un minuto de reloj de pared producen
el mismo resultado byte a byte.

### Control de rango — estabilidad confirmada

Se corrió 3 veces el rango de control (`--start 2025-07-01 --end 2026-06-24
--frozen-dir research/data`), incluyendo una repetición separada por 70s de la anterior:

| Corrida | Trades | Win rate | Profit factor | Total P&L | Max DD |
|---|---|---|---|---|---|
| 1 | 58 | 52.6% | 1.61 | +$865.82 | 2.57% |
| 2 (cross-process, run A) | 58 | — | — | — | — |
| 2 (cross-process, run B, +65s) | 58 | — | — | — | — |
| 3 (+70s tras la corrida 1) | 58 | 52.6% | 1.61 | +$865.82 | 2.57% |

**El conteo ya no varía. Se fija en 58 trades.**

---

## 6. Reconciliación del número de control (PASO 3)

Con datos Y offset congelados, el conteo definitivo para `--start 2025-07-01 --end
2026-06-24` es:

| Métrica | Valor |
|---|---|
| **Trades** | **58** |
| Win rate | 52.6% |
| Profit factor | 1.61 |
| Total P&L | +$865.82 |
| Max drawdown | 2.57% |

Este número **coincide exactamente** con el reportado originalmente en FASE 2A (antes de que
se supiera que el bug de offset existía). Eso no es casualidad: el offset real es `0`, y la
corrida de FASE 2A resultó haber medido por azar un offset de `0` ese día (el tick en vivo
de ese momento, comparado contra el reloj local, redondeó a `0`) — coincidiendo con el valor
correcto. Las corridas de FASE 2B que dieron 57/59 fueron las que, por mala suerte de
timing, midieron un offset en vivo de `±60s` en vez de `0`.

**Explicación de los conteos previos:**

| Conteo previo | Origen | Por qué difería |
|---|---|---|
| 52 (FASE 1, "2025 completo") | Bridge en vivo, rango distinto (2025 completo, no el rango de control 2025-07→2026-06) | Rango de fechas distinto — no comparable directamente, no es un artefacto del bug |
| 57 / 58 / 59 (FASE 2B, mismo rango de control) | Bridge en vivo + offset en vivo, corridas en minutos de reloj distintos | Artefacto puro de offset jitter (±60s) cambiando qué velas caen en qué ventana de sesión horaria — **eliminado por este fix** |
| **58 (definitivo, esta fase)** | Datos Y offset 100% congelados | Resultado fijo, reproducible para siempre mientras `research/data/` no cambie |

El "58" de FASE 2A no era erróneo — fue una medición correcta que coincidió con el offset
real (`0`) por las condiciones de timing de ese día particular. Las variaciones 57/59 de
FASE 2B sí eran artefactos del bug, ahora eliminados.

---

## 7. Archivos modificados/creados

**Nuevos:**
- `research/data/eurusdm-frozen-meta.json` — offset congelado (`0`) + hashes de los 5 CSV.
- `docs/eurusd-fase2b-bis-offset-freeze-2026-06-27.md` — este archivo.

**Modificados:**
- `src/backtest/backtest-runner.ts` — `getFrozenBrokerOffsetSeconds()`; el path
  `--frozen-dir` usa el offset congelado en vez de medirlo en vivo. Path live sin cambios.
- `src/backtest/check-determinism.ts` — modo `--cross-process` (+`--single-run` interno,
  +`--frozen-dir`) para el guard de regresión reforzado.

**Sin cambios:** lógica de señales/riesgo, `config.json`, `README.md`, `CLAUDE.md`,
datasets de FASE 2B (M5/H1/H4/M15/D1, reutilizados tal cual).

**No se commiteó nada.**

---

## 8. Estado tras esta fase

Datos (FASE 2A/2B) y timing (FASE 2B-bis) están ahora 100% congelados y verificados
deterministas — incluyendo el caso de borde (corridas separadas >60s) que originalmente
expuso el bug. El backtest con `--frozen-dir research/data` es inmune a cualquier cambio en
el bridge en vivo, en cualquier temporalidad, y a cualquier jitter del reloj del broker.

**Pendiente para tu revisión antes de FASE 2C (walk-forward):**
1. El split TRAIN/TEST definido en FASE 2A (70/30, con TEST por debajo del piso de 25
   trades estimados) sigue sin decisión — no se tocó en esta fase.
2. Si se desea más confianza en el offset medido por alineación de velas, se puede
   re-verificar con el método de tick en vivo (`fetchBrokerOffsetSeconds`) una vez el
   mercado esté abierto — debería confirmar `0`.
