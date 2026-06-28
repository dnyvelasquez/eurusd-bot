# Auditoría EURUSD-bot — FASE 1: determinismo del backtest (2026-06-26)

**Repo:** `C:\Personal\Develop\eurusd-bot`
**Tarea:** confirmar (y arreglar, si aplica) que el backtest sea determinista — mismo
input → mismo set de trades siempre. Sigue el mismo patrón de diagnóstico que
`spx500-bot/docs/backtest-determinism-fix.md`. No se tocó lógica de señales, no se
re-tuneó ningún parámetro, no se commiteó nada.

---

## 1. Diagnóstico

### ¿Usa medición en vivo del reloj del broker?

Sí, con la misma estructura que tenía `spx500-bot` antes de su fix:
`src/backtest/backtest-runner.ts:144` define `fetchBrokerOffsetSeconds(symbol)`, que en
cada invocación del backtest pega al bridge MT5 (`GET /api/trading/tick/:symbol`),
compara el `time` del tick contra `Date.now()` del sistema, y usa ese offset (redondeado
al minuto, cacheado solo en memoria del proceso) para normalizar los timestamps de todas
las velas (`backtest-runner.ts:391`, dentro de `runBacktest()`). El bot vivo no toca esta
función — usa el reloj del sistema directamente, igual que en SPX500.

**Runner propio, no compartido:** EURUSD-bot tiene su propio `backtest-runner.ts` e
`index.ts` (no importa nada de spx500-bot). No existe un `orb-backtest.ts` ni script de
backtest adicional en este repo — `fetchBrokerOffsetSeconds` se usa en un único lugar.

**¿Ya existe la constante determinista?** No. `getBacktestBrokerOffsetSeconds()` /
`DEFAULT_BACKTEST_BROKER_OFFSET_SECONDS` (el patrón aplicado en SPX500) no existen en
este repo — habría que crearlos desde cero si el offset resultara no-determinista. El
offset de `EURUSDm` (Exness) es independiente del de SPX500 (ThinkMarkets); no se puede
reusar la constante `10_800` de spx500-bot.

### ¿El backtest es no-determinista en la práctica?

**No, en las condiciones actuales.** Evidencia:

1. **Offset crudo medido en vivo, 5 muestras espaciadas 3s, vía `tick/EURUSDm`:**
   `-2, 0, 0, -1, -2` segundos respecto al reloj del sistema → siempre redondea a **0**
   al minuto más cercano. El servidor del broker para `EURUSDm` está, en la práctica,
   sincronizado con UTC real (a diferencia del broker de SPX500, que estaba ~3h
   desfasado). Cada corrida del backtest, en consecuencia, normaliza con offset `0` (no
   se imprime el mensaje "Broker server clock offset detected" en ninguna corrida).

2. **Dos invocaciones de `npm run backtest` en procesos separados** (mismo
   símbolo/período/config, ~2 min de diferencia entre corridas): **52/52 trades**,
   métricas idénticas.

3. **Guard de regresión en el mismo proceso** (`check-determinism.ts`, nuevo — ver §3),
   corrido contra los 4 períodos relevantes: Run A y Run B dieron el mismo set de
   trades y las mismas métricas en los **4/4** períodos probados (detalle en §4).

**Conclusión de Paso 1:** el backtest de EURUSD-bot es determinista *hoy*, porque el
offset real del broker es consistentemente ~0. La estructura del código es **idéntica a
la del bug de SPX500** (medición en vivo en cada corrida, sin constante fija) — es la
misma clase de bug, latente pero no disparado, porque este broker en particular no tiene
desfase de reloj material. Si el broker de la cuenta de `EURUSDm` cambiara de servidor,
de huso horario, o de convención DST, este mismo código volvería a producir el problema
de SPX500 (offset que driftea entre sesiones → trades que entran/salen según en qué
momento exacto se corre el backtest).

---

## 2. Decisión: no se aplicó el fix de SPX500

Por instrucción explícita de la tarea ("Paso 2 — Fix: solo si el Paso 1 confirma
no-determinismo"), y dado que el Paso 1 **no encontró no-determinismo** (offset estable
en 0 en 5 mediciones directas + 2 invocaciones de proceso separadas + 4 corridas
in-process con `check-determinism.ts`), **no se modificó `fetchBrokerOffsetSeconds` ni
se introdujo una constante de offset.**

Queda documentado aquí como **riesgo latente, no como bug activo**: si en el futuro se
audita este bot otra vez y aparece no-determinismo, la causa más probable es que el
offset del broker dejó de ser ~0 — aplicar entonces el mismo patrón que en SPX500
(medir una vez con `fetchBrokerOffsetSeconds`, fijar el valor medido como constante,
usar la constante en `runBacktest()`).

---

## 3. Lo que sí se hizo: refactor de plumbing + guard de regresión

No se tocó lógica de señales ni de riesgo. Cambios puramente estructurales, mismo patrón
ya usado en `spx500-bot`:

### `src/backtest/index.ts`
- Se extrajo toda la resolución de parámetros CLI/config (antes inline en `main()`) a una
  función exportada `resolveBacktestParams(args, cfg)`, idéntica en comportamiento a la
  versión anterior (mismos defaults, mismo orden de precedencia args > config > default).
- `main()` ahora llama a `resolveBacktestParams()` en vez de repetir la lógica.
- Se agregó `if (require.main === module)` alrededor de la invocación de `main()`, para
  poder importar `resolveBacktestParams` desde otros scripts sin disparar el CLI.

### `src/backtest/check-determinism.ts` (nuevo)
- Corre `runBacktest()` dos veces en el mismo proceso, con los parámetros que resuelve
  `resolveBacktestParams()` a partir de `config.json` — la misma resolución que usa
  `npm run backtest` real (evita el riesgo, ya documentado en el fix de SPX500, de que un
  guard con parámetros hardcodeados a mano diverja del CLI real).
- Compara el set completo de trades (clave: `openTime|signalType|side|result|pnl`) y las
  métricas agregadas. Si algo difiere, imprime el diff y sale con código 1.
- Acepta `--start`/`--end` como argumentos posicionales (default: 2025-02-01/2025-12-31).

### `package.json`
- Nuevo script: `backtest:check-determinism`.

**No se tocó:** `backtest-runner.ts` (la lógica de señales ZB/EP, el motor de bias,
zonas, momentum, FVG, etc., y `fetchBrokerOffsetSeconds` en sí). Ningún parámetro de
`config.json`. No se commiteó nada.

---

## 4. Verificación

### Guard en el mismo proceso (`npm run backtest:check-determinism -- <start> <end>`)

| Período | Run A | Run B | Resultado |
|---|---|---|---|
| 2025-02-01 → 2025-12-31 | 52 trades | 52 trades | ✅ idénticos |
| 2025-01-01 → 2025-12-31 (año calendario completo) | 52 trades | 52 trades | ✅ idénticos |
| 2025-07-01 → 2026-06-24 | 58 trades | 58 trades | ✅ idénticos |
| 2026-01-01 → 2026-06-25 | 27 trades | 27 trades | ✅ idénticos |

Todos los `JSON.stringify` de claves de trade y de métricas agregadas coincidieron
byte-a-byte entre Run A y Run B en los 4 períodos.

### Dos procesos separados (`npm run backtest`, invocado dos veces, ~2 min de diferencia)

| Período | Corrida 1 | Corrida 2 | Resultado |
|---|---|---|---|
| 2025-02-01 → 2025-12-31 | 52 trades, P&L +$822.80, PF 1.65 | 52 trades, P&L +$822.80, PF 1.65 | ✅ idénticos |

### Typecheck y CLI normal

| Verificación | Resultado |
|---|---|
| `npm run typecheck` (tras el refactor de `index.ts` + nuevo `check-determinism.ts`) | ✅ limpio |
| `npm run backtest -- --start 2025-02-01 --end 2025-12-31` (sin tocar nada más) | ✅ 52 trades — mismo resultado que antes del refactor |

---

## 5. Comparación contra los números citados en README / auditoría previa

La auditoría de validación previa (`spx500-bot/docs/eurusd-btcusd-validation-audit-2026-06-25.md`,
citando `README.md:371-374` de ese momento) reporta:
- 2025: **54** trades
- jul-2025 → jun-2026: **56** trades
- 2026 parcial: **26** trades

Los números deterministas medidos hoy, para los mismos períodos:

| Período | README/auditoría previa | Medido hoy (determinista) | Diferencia |
|---|---|---|---|
| 2025 (año completo) | 54 | **52** | -2 |
| jul-2025 → jun-2026 | 56 | **58** | +2 |
| 2026 parcial (ene-jun) | 26 | **27** | +1 |

**Esta diferencia NO es el bug de offset** — quedó demostrado en §4 que el resultado es
100% reproducible (mismo set de trades, mismas métricas) tanto en el mismo proceso como
en procesos separados, para los 4 períodos probados, con offset medido consistentemente
en 0. La causa de la diferencia con los números del README queda fuera del alcance de
esta fase (la tarea pidió explícitamente no investigar estadística, contaminación ni
parámetros). Candidatos plausibles a revisar en una fase posterior, sin tocarlos ahora:
historial de velas del bridge MT5 que pudo revisarse/extenderse desde que se generó el
README, o algún ajuste de config/código entre la fecha del README y hoy.

---

## 6. Archivos modificados/creados

**Modificados:**
- `src/backtest/index.ts` — extracción de `resolveBacktestParams()`, guard
  `require.main === module`. Sin cambio de comportamiento.
- `package.json` — script `backtest:check-determinism`.

**Nuevos:**
- `src/backtest/check-determinism.ts` — guard de regresión.
- `docs/eurusd-determinism-audit-2026-06-26.md` — este archivo.

**No se tocó:** `src/backtest/backtest-runner.ts` (incluida `fetchBrokerOffsetSeconds`),
ninguna lógica de señales (ZB/EP), ningún parámetro de `config.json`. No se commiteó
nada.

---

## 7. Pendiente / nota para más adelante

`fetchBrokerOffsetSeconds()` sigue siendo una medición en vivo en cada corrida — el mismo
patrón que causó el bug en SPX500. Hoy es benigno porque el offset real es ~0, pero es un
riesgo estructural, no resuelto. Si una auditoría futura encuentra trade counts que
varían entre corridas del backtest de EURUSD, **no asumir que es un bug nuevo**: medir
primero el offset real (`curl http://127.0.0.1:8001/api/trading/tick/EURUSDm` vs. el
reloj del sistema) y, si dejó de ser ~0, aplicar el mismo fix que en SPX500 (constante
fija medida una vez, función `getBacktestBrokerOffsetSeconds()`, sin tocar el path live).
