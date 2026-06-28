# EURUSD-bot — Resumen ejecutivo de la auditoría de validación (FASES 1–2C)

**Punto de entrada para la próxima sesión.** Si vas a tocar EURUSD-bot, lee esto primero.

**Fecha de cierre de la auditoría:** 2026-06-27/28
**Veredicto:** edge real pero frágil. **No fondear real todavía** — ver §4.

---

## 1. Qué se hizo y por qué

El README tenía números de backtest (PF~1.6, 54 trades, "Feb–Dic 2025") medidos contra el
bridge MT5 en vivo, sin holdout, sin congelar nada. Esa medición no era confiable: el
histórico de velas y el reloj del broker que sirve el bridge **cambian entre corridas** —
el mismo comando, el mismo rango de fechas, en días distintos, daba resultados distintos.
Esta auditoría existió para resolver eso ANTES de confiar en cualquier número de
performance, siguiendo la misma disciplina ya aplicada a SPX500 (ver `CLAUDE.md` del
portafolio).

## 2. Las 5 fases, en una línea cada una

| Fase | Qué resolvió | Doc |
|---|---|---|
| 1 (previa) | Detectó el problema: bridge en vivo no es determinista | `eurusd-determinism-audit-2026-06-26.md` |
| 2A | Congeló M5 a CSV versionado + hash; definió split TRAIN/TEST (no usado finalmente) | `eurusd-fase2a-dataset-freeze-2026-06-26.md` |
| 2B | Congeló H1/H4/M15/D1 (las 4 temporalidades que faltaban) | `eurusd-fase2b-full-dataset-freeze-2026-06-26.md` |
| 2B-bis | Congeló el offset de reloj del broker (la pieza que seguía rompiendo el determinismo) | `eurusd-fase2b-bis-offset-freeze-2026-06-27.md` |
| 2C | Walk-forward de VALIDACIÓN (no optimización) sobre el dataset 100% congelado, 2 hipótesis pre-registradas | `eurusd-fase2c-walkforward-2026-06-27.md` |

## 3. El resultado (FASE 2C, lo que importa)

**Dataset:** 100% congelado — M5/H1/H4/M15/D1 + offset de reloj, cada uno con SHA256
verificado. Reproducible con `--frozen-dir research/data`, inmune al bridge en vivo. Hash
M5 de referencia: `2ab3a8aa...` (5 hashes completos en
`research/data/eurusdm-frozen-meta.json`).

**Diseño:** 5 ventanas OOS consecutivas (~99 días c/u) sobre los ~16.4 meses de histórico
real (2025-02-17 → 2026-06-26). Dos hipótesis fijas, pre-registradas, ambas medidas (no se
eligió ganadora):
- **A** = config actual de producción, CON `BLOCKED_HOURS`.
- **B** = la misma config, SIN `BLOCKED_HOURS` (único cambio).

**Agregado OOS:**

| | A (con blocked hours) | B (sin blocked hours) |
|---|---|---|
| n cerrados | 78 | 121 |
| Media R | **+0.296** | +0.119 |
| Bootstrap P(media>0) | **97.9%** | 84.4% |
| Ventanas con expectancy + | 4/5 | 3/5 |
| Cumple los 3 criterios pre-registrados de "edge real" | ✅ | ❌ |

**A − B = +0.177, pero los IC95% se solapan y Welch t-test da p=0.355 (no significativo).**
No hay evidencia de que los `BLOCKED_HOURS` específicamente causen el edge — quedan "no
refutados pero no probados".

## 4. Por qué el veredicto es "frágil", no "validado"

1. **Concentración:** sin la mejor ventana (W4, +0.879R), la media de A cae a +0.168R —
   apenas sobre el umbral de 0.15 pre-registrado.
2. **El tramo más reciente es negativo en AMBAS hipótesis** (W5, 2026-03-19→2026-06-26: A
   −0.245R, B −0.524R). Con n=14 no es estadísticamente distinguible de varianza normal,
   pero tampoco se puede descartar un cambio de régimen.
3. **El modelo de costos solo incluye spread.** Bajo una comisión retail estimada
   ($7/lote round-turn), A sigue cumpliendo los 3 criterios (+0.246R) pero con margen menor;
   no se verificó si la cuenta real paga esa comisión o no.

## 5. Próximo paso — NO es código, es tiempo

**Forward-test en demo** para ver si W5 fue un bache transitorio o el inicio de un cambio de
régimen. **Revisar en ~6-8 semanas (objetivo: ~2026-08-22)** con los trades nuevos
acumulados desde esa fecha. **No fondear capital real en EURUSD-bot hasta resolver esa
pregunta.**

## 6. Infraestructura que quedó construida (reutilizable para BTCUSD)

- Congelación de dataset por temporalidad con hash SHA256 versionado
  (`scripts/freeze-dataset.ts`, ya genérico en symbol/tf).
- Congelación del offset de reloj del broker junto al dataset
  (`research/data/<symbol>-frozen-meta.json`).
- Guard de regresión `check-determinism.ts --cross-process`: detecta no-determinismo entre
  invocaciones SEPARADAS en el tiempo (no solo dentro del mismo proceso) — esto es lo que
  expuso el bug de offset en FASE 2B/2B-bis.
- Flags de backtest: `--frozen-dir <dir>`, `--no-blocked-hours true`,
  `--commission-per-lot <valor>`.

Construir el mismo mecanismo en btcusd-bot ANTES de su propia auditoría evita repetir el
ciclo de 3 fases que tomó llegar a un dataset+timing 100% deterministas en EURUSD.

## 7. Qué NO se hizo (fuera de alcance, a propósito)

- No se re-tuneó ningún parámetro de señal/riesgo en ninguna fase.
- No se construyó walk-forward de OPTIMIZACIÓN (solo de validación, parámetros fijos).
- No se decidió entre Hipótesis A y B — ambas se midieron, ninguna se eligió como ganadora
  por decisión unilateral del análisis.
- No se tocó el bot en vivo ni `config.json` en ningún punto.
