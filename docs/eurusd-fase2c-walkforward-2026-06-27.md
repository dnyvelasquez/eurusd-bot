# Auditoría EURUSD-bot — FASE 2C: walk-forward de validación (2026-06-27/28)

**Repo:** `C:\Personal\Develop\eurusd-bot`
**Tarea:** validar (no optimizar) dos hipótesis fijas y pre-registradas sobre el dataset
100% congelado de FASE 2A/2B/2B-bis. No se re-derivaron parámetros, no se eligió hipótesis
ganadora, no se commiteó nada. Esto es medición — la decisión queda para ti sobre el
agregado reportado abajo.

---

## 0. Verificación de hashes (obligatoria antes de correr)

```
M5  OK 2ab3a8aade012f5a850f9a591d78670694e1a6a92d1a5def255757837a014b75
H1  OK 286e71fc03bea91ef757f8fd5ab35fc1c3a12ea50e4406dc52c5ee9af2ca4088
H4  OK 18ad5acec344af000d971f4cde36d1c3d3ba05138efc0eda7fb7c11fabb0446b
M15 OK 9407d37c9ff8c006131595596146d06bfd7582cf0a0e4e82a5ea2980a2c5e584
D1  OK 9413c55187aed308d8f6129da3e8f4451a984664d2be77f0220a72adf4fad151
```

Los 5 hashes en disco (`research/data/*.csv`) coinciden exactamente con
`eurusdm-frozen-meta.json`. Se procedió a correr.

---

## 1. Diseño del walk-forward

Todas las corridas usan `--frozen-dir research/data` (datos + offset de reloj 100%
congelados, FASE 2A/2B/2B-bis). Rango con datos reales: `2025-02-17 → 2026-06-26`
(~494 días, ~16.4 meses).

**5 ventanas consecutivas, no solapadas, de ~99 días cada una** (criterio: suficientes para
ver consistencia temporal sin que cada tramo quede con un puñado trivial de trades):

| Ventana | Desde | Hasta | Días |
|---|---|---|---|
| W1 | 2025-02-17 | 2025-05-27 | 99 |
| W2 | 2025-05-27 | 2025-09-03 | 99 |
| W3 | 2025-09-03 | 2025-12-10 | 98 |
| W4 | 2025-12-10 | 2026-03-19 | 99 |
| W5 | 2026-03-19 | 2026-06-26 | 99 |

**Cada ventana es 100% OOS respecto a la configuración** — no hay TRAIN que re-optimizar
aquí, ambas hipótesis usan parámetros fijos de antemano en las 5 ventanas.

**Método:** se corrió backtest ÚNICO continuo sobre todo el rango (`--start 2025-02-17
--end 2026-06-26 --frozen-dir research/data`) para cada hipótesis, y se asignó cada trade a
su ventana por fecha de apertura. Esto es metodológicamente más correcto que correr 5
backtests aislados: los indicadores HTF (SMA200 D1, EMA/ADX H4-H1, zonas D1-H1) ya tienen
su warm-up completo desde antes de `2025-02-17` (FASE 2B) y no se reinician artificialmente
en cada corte de ventana.

### Conteo de trades por ventana — ANTES de cualquier análisis

| Ventana | Hipótesis A (con BLOCKED_HOURS) | Hipótesis B (sin BLOCKED_HOURS) |
|---|---|---|
| W1 | 13 | 22 |
| W2 | 17 | 31 |
| W3 | 21 | 29 |
| W4 | 14 | 20 |
| W5 | 14 | 20 |
| **Total** | **79** | **122** |

Ambas hipótesis quedan con ventanas de tamaño razonable (mínimo 13 trades en A, 20 en B) —
ninguna ventana cae en un puñado trivial. Cada hipótesis tiene 1 trade abierto (sin cerrar)
al final del rango (`2026-06-08`), excluido del análisis de R (sin resultado realizado);
los conteos de R/expectancy de abajo usan 78 trades cerrados para A y 121 para B (120 en
la corrida con comisión, ver §5).

---

## 2. Dos hipótesis fijas (sin elegir, ambas corridas igual)

- **Hipótesis A** — `config.json` actual, tal cual, CON sus `BLOCKED_HOURS`:
  - Asian session (low liquidity): 17:00–03:00 ET
  - NY Lunch (low volume): 11:00–13:00 ET
- **Hipótesis B** — exactamente la misma config (`--frozen-dir research/data`, mismos
  parámetros de señal/riesgo), con `BLOCKED_HOURS` vacío (flag nuevo `--no-blocked-hours
  true`, ver §6). Único cambio entre A y B.

No se corrió ninguna otra variante.

---

## 3. Resultados por ventana

### Hipótesis A (con blocked hours)

| Ventana | n (cerrados) | WR% | Mean R | Sum R |
|---|---|---|---|---|
| W1 | 13 | 53.8% | +0.397 | +5.16 |
| W2 | 17 | 47.1% | +0.198 | +3.36 |
| W3 | 20 | 55.0% | +0.284 | +5.69 |
| W4 | 14 | 71.4% | +0.879 | +12.31 |
| W5 | 14 | 35.7% | **−0.245** | **−3.43** |

Ventanas con expectancy positiva: **4/5**. Negativa: 1/5 (W5).

### Hipótesis B (sin blocked hours)

| Ventana | n (cerrados) | WR% | Mean R | Sum R |
|---|---|---|---|---|
| W1 | 22 | 59.1% | +0.551 | +12.13 |
| W2 | 31 | 38.7% | −0.006 | −0.20 |
| W3 | 28 | 50.0% | +0.134 | +3.75 |
| W4 | 20 | 55.0% | +0.459 | +9.18 |
| W5 | 20 | 20.0% | **−0.524** | **−10.49** |

Ventanas con expectancy positiva: **3/5**. Negativa: 2/5 (W2 ≈0/negativo marginal, W5).

---

## 4. Agregado OOS (junta los R de TODAS las ventanas)

Costos: spread real de `EURUSDm` tal como ya lo usa el backtest (`SPREAD_POINTS=0.0001`,
~1 pip, aplicado al precio de entrada). **El modelo de costos actual NO incluye comisión**
— ver §5 para la corrida de sensibilidad con comisión estimada.

| | **Hipótesis A** | **Hipótesis B** |
|---|---|---|
| n (trades cerrados) | 78 | 121 |
| Media R | **0.2960** | **0.1188** |
| Std R | 1.3220 | 1.3085 |
| t-stat (H0: media ≤ 0, 1 cola) | 1.978 | 0.998 |
| p-valor (1 cola) | **0.0258** | 0.1601 |
| IC95% (t-dist) | [−0.0020, 0.5941] | [−0.1168, 0.3543] |
| Bootstrap IC95% (10,000 resamples) | [0.0082, 0.5905] | [−0.1071, 0.3533] |
| Bootstrap P(media > 0) | **97.9%** | 84.4% |
| Media R ganadoras | 1.466 | 1.507 |
| Media R perdedoras | −1.000 | −1.000 |
| Ratio W/L (conteo) | 1.108 | 0.806 |
| Ventanas con expectancy + | 4/5 | 3/5 |

### A vs B — diferencia

- Media R (A − B) = **+0.1773**
- IC95% A = [−0.0020, 0.5941]; IC95% B = [−0.1168, 0.3543] → **se solapan**
- Welch t-test (diferencia de medias, muestras independientes): t = 0.927, p (2 colas) =
  **0.3552** (no significativo)

---

## 5. Sensibilidad de costos — comisión retail estimada

**El modelo de costos del backtest solo carga spread** (`spreadPoints`, sumado/restado al
precio de entrada). No hay línea de comisión en ningún punto del cálculo de P&L
(`backtest-runner.ts`, confirmado por inspección — `PositionSizing` calcula el tamaño de
posición pero el volumen resultante nunca se usaba en el cálculo de P&L antes de esta
fase). Para no sobre-estimar el edge, se agregó un parámetro de sensibilidad
`commissionPerLot` (nuevo, plumbing puro — no toca lógica de señales) y se corrió una vez
más con una **comisión estimada de $7 por lote estándar por round-turn** (estimación típica
de cuentas ECN/Raw retail en EURUSD; una cuenta Standard de Exness normalmente no cobra
comisión separada, así que esto es un escenario conservador/pesimista, no necesariamente el
real de esta cuenta — no se verificó el tipo de cuenta).

| | A (spread only) | **A + comisión $7/lote** | B (spread only) | **B + comisión $7/lote** |
|---|---|---|---|---|
| n | 78 | 78 | 121 | 120* |
| Media R | 0.2960 | 0.2463 | 0.1188 | 0.0529 |
| p-valor (1 cola) | 0.0258 | 0.0521 | 0.1601 | 0.3289 |
| Bootstrap P(media>0) | 97.9% | 95.1% | 84.4% | 66.8% |

\* La comisión reduce el P&L diario, lo cual interactúa con el circuit-breaker
`MAX_CONSEC_LOSS_DAYS` (gatea por si el balance del día fue negativo, comparación que SÍ
depende de magnitud en $) — esto puede cambiar cuál día se bloquea para nuevas entradas y,
en cascada, qué trade específico se abre después. Para B (mayor frecuencia, más probable
tocar el límite diario) esto desplazó 1 trade neto (122→121→120 entre variantes con/sin
comisión). Para A no se observó cambio en el conteo de trades. Esto es un efecto de segundo
orden real del modelo de riesgo, no un bug — se documenta para que no sorprenda si alguien
re-corre esto con otro valor de comisión y el conteo exacto difiere en ±1.

**Bajo comisión, A sigue por encima del umbral de "edge real" (con margen reducido); B se
aleja más del umbral.**

---

## 6. Cambios de plumbing necesarios para esta fase

- **`src/backtest/index.ts`**: nuevo flag `--no-blocked-hours true` → fuerza
  `blockedHours: []` en `resolveBacktestParams()` sin tocar `config.json` ni el bot live.
- **`src/backtest/backtest-runner.ts`**: nuevo parámetro opcional `commissionPerLot` en
  `BacktestParams` — cuando >0, se descuenta `volume × commissionPerLot` del P&L (y de
  `actualRr`, proporcional a `riskAmount`) de cada trade cerrado, ADEMÁS del spread ya
  existente. El clasificador WIN/LOSS de cada trade NO cambia (sigue determinado por qué
  lado del precio se tocó primero, igual que antes) — solo se ajusta la magnitud. Flag CLI:
  `--commission-per-lot <valor>`.
- Ningún cambio en lógica de señales, zonas, ADX, SMA200, momentum, ni en el bot en vivo.
  `npm run typecheck`: limpio.

---

## 7. Chequeo de criterios pre-registrados (solo marca, sin concluir)

### "Edge real" — media R agregada OOS ≥ 0.15 Y bootstrap P(media>0) ≥ 90% Y expectancy + en la MAYORÍA de ventanas

| Criterio | Hipótesis A | Hipótesis B |
|---|---|---|
| Media R OOS ≥ 0.15 | ✅ 0.296 | ❌ 0.119 |
| Bootstrap P(media>0) ≥ 90% | ✅ 97.9% | ❌ 84.4% |
| Expectancy + en mayoría de ventanas | ✅ 4/5 | ✅ 3/5 |
| **Los 3 a la vez** | **✅ CUMPLE** | **❌ NO CUMPLE** (falla 2 de 3) |

Bajo comisión estimada ($7/lote): A sigue cumpliendo los 3 (0.246 ≥0.15, 95.1% ≥90%, 4/5
ventanas — la ventana-a-ventana no se recalculó con comisión pero el agregado se mantiene
por encima del umbral). B sigue sin cumplir, y se aleja más (0.053, 66.8%).

### "Los blocked hours aportan" — A supera a B por un margen mayor que el ruido

| Chequeo | Resultado |
|---|---|
| A > B nominalmente | ✅ Sí (diferencia +0.177) |
| Margen mayor que el ruido (IC no se solapan) | ❌ **Los IC SÍ se solapan** |
| Diferencia de medias estadísticamente significativa (Welch t-test) | ❌ No (p=0.355) |
| ¿B ≥ A? | No — pero la condición complementaria ("A supera a B fuera del ruido") tampoco se cumple |

Según el criterio pre-registrado tal como fue definido, el resultado cae en zona ambigua:
B no supera a A, pero A tampoco supera a B de forma distinguible del ruido muestral con
este tamaño de muestra (n=78 vs n=121 R's, ventanas de ~3 meses). No se puede marcar ni
"los blocked hours aportan" ni "B≥A" de forma limpia con los datos actuales.

---

## 8. Consistencia temporal — ¿depende de un solo tramo?

- **Hipótesis A:** el agregado positivo (mean R=0.296) tiene su contribución más fuerte en
  W4 (mean R=0.879, suma +12.31 R) — el tramo más fuerte por lejos. Sin W4, la media de los
  4 tramos restantes sería: (5.16+3.36+5.69−3.43)/(13+17+20+14)=10.78/64≈+0.168 — **sigue
  siendo positiva incluso excluyendo el mejor tramo**, aunque el margen sobre el umbral de
  0.15 se vuelve mucho más ajustado. No es un resultado sostenido por un solo trade, pero sí
  está notablemente concentrado en 1 de 5 ventanas.
- **Hipótesis B:** patrón similar — W1 y W4 cargan casi toda la ganancia (+12.13 y +9.18),
  mientras W2 es ~plano y W5 es fuertemente negativo (−10.49). Sin W1: media de los 4 tramos
  restantes = (−0.20+3.75+9.18−10.49)/(31+28+20+20)=2.24/99≈+0.023 — prácticamente nulo.
  **El resultado agregado de B depende mucho más de un solo tramo (W1) que el de A.**
- **Ambas hipótesis comparten W5 como el peor tramo** (negativo en ambas, y el más negativo
  de las 5 ventanas) — no es un artefacto de los blocked hours, ocurre igual con o sin
  ellos. Vale la pena anotar como posible cambio de régimen reciente (2026-03-19 →
  2026-06-26) más que como ruido de una sola operación.

---

## 9. Archivos modificados/creados

**Nuevos:**
- `docs/eurusd-fase2c-walkforward-2026-06-27.md` — este archivo.

**Modificados:**
- `src/backtest/index.ts` — flag `--no-blocked-hours`.
- `src/backtest/backtest-runner.ts` — parámetro `commissionPerLot` (sensibilidad de costos).

**Sin cambios:** lógica de señales/riesgo/zonas/ADX/SMA200, `config.json`, `README.md`,
`CLAUDE.md`, datasets congelados (FASE 2A/2B/2B-bis, reutilizados tal cual, hashes
verificados antes de correr).

**No se commiteó nada.**

---

## 10. Resumen para tu decisión (sin recomendación)

- **A (con blocked hours) cumple los 3 criterios pre-registrados de "edge real"** bajo el
  modelo de costos actual (solo spread) y se mantiene por encima del umbral bajo el
  escenario de comisión estimada. **B (sin blocked hours) no cumple** ninguno de los dos
  primeros criterios.
- Sin embargo, **la ventaja de A sobre B no es distinguible del ruido muestral** con los
  IC actuales (se solapan; Welch p=0.355) — no hay evidencia estadística sólida de que los
  blocked hours específicamente sean la causa de que A cumpla y B no, más allá de lo que ya
  muestran los criterios de "edge real" evaluados por separado.
- El resultado de A está más distribuido entre ventanas que el de B (B depende fuertemente
  de un solo tramo, W1), lo cual es un punto a favor de A más allá del agregado puntual.
- Ambas comparten el mismo tramo más reciente (W5) negativo — posible señal a vigilar, no
  analizada más a fondo aquí (fuera de alcance: esto es medición, no diagnóstico de causa).

Quedo a la espera de tu decisión antes de tocar README/CLAUDE.md o construir cualquier
siguiente fase.
