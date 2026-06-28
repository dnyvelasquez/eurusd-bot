<!-- BLOQUE COMPARTIDO — idéntico en spx500-bot, eurusd-bot y btcusd-bot.
Si editas algo aquí, actualízalo en los TRES repos en la misma tanda. Nunca en uno solo. -->

## Tesis de portafolio (multi-estrategia por instrumento)
- SPX500 → swing / trend-following / momentum (timeframe alto: daily/H4).
  Razón: deriva alcista estructural favorece momentum; costos triviales vs. movimiento;
  daily libera 20+ años de historia para OOS multi-régimen (escapa al límite de 11 meses M5).
- EURUSD → scalping / day trading / mean-reversion.
  Razón: par mean-reverting, máxima liquidez, costos mínimos.
- BTCUSDT → scalping / day trading.
  Razón: volatilidad intradía alta, 24/7 → masa de trades para significancia.
- Intradía (EURUSD/BTCUSDT) no paga swap overnight, vive en la infraestructura MT5 actual, y
  calza con eventual challenge de fondeo (FTMO: target 10% sin límite de tiempo, pero -5%
  diario / -10% total son el filtro real → favorece bajo riesgo por trade + alta frecuencia).
- Objetivo de portafolio: estrategias de baja correlación (trend vs. fade ganan en regímenes
  distintos) → drawdown agregado suavizado.
- Disciplina innegociable (aplica a TODOS los instrumentos): criterios de éxito pre-registrados
  antes de medir; split train/test con holdout sellado; backtest determinista; sin re-tuning
  sobre datos de medición. El prior favorable de un instrumento NO reemplaza la validación.

## Estrategias archivadas (resultado negativo, no borrar — evitar re-explorar a ciegas)
- SMC/ICT cascade en SPX500 M5: no significativo (p≈0.14) + contaminado in-sample (commit a969db6).
- SMC en NAS100 (OOS de instrumento): falla bajo breakeven (WR 30%, R -0.18). Falsación limpia.
- VWAP-fade en SPX500 M5: frecuencia inviable (0.25/día) + 0/9 celdas pasan criterios en train.

<!-- BLOQUE ESPECÍFICO eurusd-bot -->

## EURUSD-bot — auditoría de validación completada (FASES 1–2C) — 2026-06-27
Repo: `C:\Personal\Develop\eurusd-bot`. Edge real pero frágil: +0.296R OOS walk-forward
(5 ventanas, n=78 cerrados, bootstrap P(media>0)=97.9%, cumple los 3 criterios
pre-registrados de "edge real"), pero concentrado en una sola ventana (sin la mejor cae a
+0.168R, al borde del umbral) y con el tramo más reciente (W5, mar-jun 2026) negativo en
ambas hipótesis probadas. Blocked hours NO probados como causa — A (con ellos) y B (sin
ellos) no son distinguibles fuera del ruido (Welch p=0.355). Detalle completo y resumen
ejecutivo: `docs/eurusd-audit-summary-2026-06-27.md` en ese repo.
**PRÓXIMO PASO:** forward-test en demo para resolver si W5 es bache transitorio o cambio de
régimen — revisar con los trades nuevos acumulados en **~6-8 semanas (objetivo:
~2026-08-22)**. **NO fondear real hasta resolver W5.**

**Infraestructura reutilizable (patrón replicable para BTCUSD):** dataset congelado por
temporalidad (M5/H1/H4/M15/D1, hash SHA256 versionado) + offset de reloj del broker
congelado junto al dataset + guard de regresión cross-process (detecta no-determinismo
entre invocaciones separadas en el tiempo, no solo en el mismo proceso) + flags de backtest
`--frozen-dir` / `--no-blocked-hours` / `--commission-per-lot`. Construir el mismo
mecanismo en btcusd-bot antes de su propia auditoría de validación evita repetir el ciclo de
3 fases (2A/2B/2B-bis) que tomó resolver esto en EURUSD.
