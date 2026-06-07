# EURUSD Bot

Bot de trading algorítmico para EUR/USD basado en EMA Pullback. Analiza el mercado en tiempo real, detecta setups de alta probabilidad y ejecuta órdenes automáticamente a través de MetaTrader 5 en Exness.

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                    MetaTrader 5                          │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              mt5-bridge  (Python / FastAPI)              │
│  /health  /account  /candles  /positions  /trade        │
│  /settings  /license  /telegram  /status  /journal      │
│  Dashboard web  →  http://localhost:8001                 │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────────┐
│                  bot-core  (TypeScript)                  │
│                                                          │
│  MarketDataService  (D1 / H4 / H1 / M15 / M5)          │
│    ├─ EMAEngine        (EMA 8/34 en H4, H1 y M15)      │
│    ├─ MACDEngine       (histograma MACD en M15)         │
│    ├─ ADXEngine        (ADX en H4 para filtro de trend) │
│    ├─ ChoppinessEngine (Choppiness Index en H4)         │
│    ├─ FVGDetector      (Fair Value Gaps en M5)          │
│    ├─ DisplacementDetector  (velas impulso en M5)       │
│    ├─ EntryValidator   (momentum + FVG + displacement)  │
│    ├─ PositionSizing   (riesgo % del balance vía tick value MT5) │
│    └─ PositionMonitor  (trailing stop configurable)     │
│                                                          │
│  Filtros de riesgo (se evalúan antes de cada orden)     │
│    ├─ NewsFilterService      (bloqueo ±1 min noticias)  │
│    ├─ SessionGuard           (horarios bloqueados ET)   │
│    ├─ DailyTradeCountGuard   (máximo trades por día)    │
│    ├─ DailyLossGuard         (máximo pérdidas por día)  │
│    └─ ConsecLossGuard        (circuit breaker diario)   │
│                                                          │
│  TradeJournalService  (registro de operaciones en DB)   │
│  BotStatusService     (semáforo en tiempo real)         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Telegram Bot  (notificaciones)              │
└─────────────────────────────────────────────────────────┘
```

## Estrategias activas: Zone Bounce [ZB] + EMA Pullback [EP]

El bot opera dos estrategias complementarias sobre EURUSDm. La señal se evalúa en cada vela M5 cerrada dentro del horario de sesión: ZB tiene prioridad; EP aplica si ZB no genera señal.

### Filtro de tendencia SMA200 D1

Antes de confirmar cualquier señal, el bot verifica que el precio esté al mismo lado de la **SMA 200 en D1** que la dirección del trade:
- BULLISH: precio debe estar **por encima** de SMA200 D1
- BEARISH: precio debe estar **por debajo** de SMA200 D1

Configurable con `SMA_TREND_PERIOD` (200) y `SMA_TREND_TF` ("D1").

### Zone Bounce [ZB]

1. **Zona activa** — ZoneEngine identifica zonas S/R en D1/H4/H1/M15. El precio debe estar dentro de `ZONE_PROXIMITY_POINTS` de la zona.
2. **Sesgo HTF multi-TF** — BiasEngine confirma dirección (BULLISH/BEARISH) en D1/H4/H1. Rechaza señales en rango (RANGE).
3. **Alineación zona/sesgo** — BULLISH → zona de soporte; BEARISH → zona de resistencia.
4. **Momentum M15** — MomentumEngine debe confirmar la dirección del sesgo.
5. **Entrada M5** — requiere FVG o displacement en M5. SL más allá del nivel de zona ± buffer. TP mínimo 2:1 R:R.

### EMA Pullback [EP]

1. **Alineación top-down H4 → H1** — `EP_H4_ALIGN=true`: EMA8 H4 debe estar al mismo lado de EMA34 que la dirección H1.

2. **Tendencia H1 confirmada** — EMA8 > EMA34 en H1 → BULLISH; EMA8 < EMA34 → BEARISH. La separación entre EMAs debe ser ≥ `EMA_SPREAD_MIN` para evitar mercados choppy.

3. **Filtro ADX H4** — el ADX en H4 debe estar dentro del rango `[EP_ADX_MIN, EP_ADX_MAX]`:
   - ADX < 20: mercado sin tendencia (rango) → señal descartada.
   - ADX > 30: tendencia sobreextendida, alta probabilidad de reversión → señal descartada.
   - El rango 20-30 captura mercados con tendencia real sin overextension.

4. **Régimen de mercado (Choppiness Index)** — si el CI en H4 supera `CI_MAX` (61.8), el mercado está en rango y la señal se descarta.

5. **Precio cerca de EMA34 en M15** — el precio actual debe estar dentro de `ZONE_PROXIMITY_POINTS` de la EMA34 en M15.

5. **MACD confirma momentum** — el histograma MACD en M15 debe estar en la dirección del trade (>0 BULLISH, <0 BEARISH).

7. **Entrada y niveles** — SL más allá de la EMA34 en M15 (`ZONE_SL_BUFFER_POINTS`). TP mínimo 2:1 R:R.

## Filtros de riesgo

| Filtro | Comportamiento |
|---|---|
| **News filter** | Bloquea señales ±1 minuto alrededor de noticias EUR/USD de alto impacto (Forex Factory). Se refresca cada día a medianoche UTC. |
| **Session guard** | Bloquea señales fuera de las ventanas horarias permitidas. Usa hora ET con soporte automático de DST. |
| **Daily loss limit** | Si el número de pérdidas del día ET alcanza `MAX_DAILY_LOSSES` (2), no se abren más posiciones hasta el día siguiente. |
| **Consecutive bad days** | Si se cierran `MAX_CONSEC_LOSS_DAYS` días consecutivos con pérdida neta, el bot pausa hasta el lunes siguiente. `0` = desactivado (default actual). |
| **Daily trade limit** | Si el número de trades del día alcanza `MAX_DAILY_TRADES`, no se abren más posiciones. `0` = sin límite. |
| **Consecutive loss circuit** | Si se cierran `MAX_CONSEC_LOSSES` pérdidas seguidas en el mismo día ET, bloquea el resto del día. `0` = desactivado. |
| **Signal cooldown** | Mínimo `SIGNAL_COOLDOWN_MINUTES` (60 min) entre señales EP para evitar re-entradas. |

### Ventanas de operación (hora ET)

El bot opera en **dos franjas activas** separadas por zonas de baja calidad de señal, determinadas por análisis histórico de 16 meses.

| Franja | Horario ET | Descripción |
|---|---|---|
| 🔴 Bloqueado | 17:00 – 06:00 | Sesión asiática + apertura temprana Londres (price discovery, dirección no establecida) |
| 🟢 **London activo** | 06:00 – 11:00 | Mid-London: dirección del día establecida, volumen institucional real |
| 🔴 Bloqueado | 11:00 – 13:00 | NY Lunch — volumen bajo, movimientos falsos |
| 🟢 **NY tarde** | 13:00 – 17:00 | Mejor franja: liquidez post-almuerzo, tendencias con mayor follow-through |

### Análisis histórico por hora (Feb 2025 – Jun 2026)

| Hora ET | Trades | WR | P&L | Estado |
|---|---|---|---|---|
| ~~03:00~~ | ~~31~~ | ~~45%~~ | ~~-$0~~ | ~~Bloqueado (price discovery)~~ |
| ~~04:00~~ | ~~5~~ | ~~40%~~ | ~~-$10~~ | ~~Bloqueado~~ |
| ~~05:00~~ | ~~6~~ | ~~50%~~ | ~~+$25~~ | ~~Bloqueado~~ |
| 06:00 | 10 | 40% | -$4 | London |
| 07:00 | 13 | 62% | +$39 | London |
| 08:00 | 13 | 54% | +$53 | London+NY |
| 09:00 | 10 | 50% | +$15 | London+NY |
| 10:00 | 14 | 57% | +$43 | London+NY |
| ~~11:00~~ | ~~16~~ | ~~38%~~ | ~~-$23~~ | ~~Bloqueado (NY Lunch)~~ |
| ~~12:00~~ | ~~10~~ | ~~20%~~ | ~~-$61~~ | ~~Bloqueado (NY Lunch)~~ |
| **13:00** | **8** | **88%** | **+$100** | **NY tarde ★** |
| **14:00** | **7** | **100%** | **+$85** | **NY tarde ★** |
| 15:00 | 2 | 0% | -$20 | NY |
| 16:00 | 5 | 20% | -$22 | NY |

> ★ La franja 13:00–15:00 ET concentra el mejor rendimiento histórico. Los primeros 2h de Londres (03–05 ET) y el almuerzo de NY (11–13 ET) son las ventanas de mayor ruido y peor WR.

Las ventanas se configuran en `BLOCKED_HOURS` y `EP_MIN_HOUR` en `config.json` con hot-reload sin reiniciar el bot.

## Gestión de posiciones

Una vez abierta una posición, el bot la monitorea en cada ciclo de sync (10s):

- **Trailing stop** — cuando `TRAIL_RR > 0`: el SL sigue al precio manteniéndose a `TRAIL_RR × slDist` detrás del precio actual. Activa cuando el precio se mueve `TRAIL_RR × slDist` a favor. Con `TRAIL_RR=1.5`, el SL se activa al alcanzar 1.5R de ganancia y sigue a 1.5R detrás del precio máximo/mínimo favorable.
- **Break-even** (opcional) — cuando `BE_AT_POINTS > 0` y el precio se mueve ese valor en precio a favor, el SL se mueve al precio de entrada + `BE_BUFFER_POINTS`.
- **Partial TP** (opcional) — cuando `PARTIAL_TP_ENABLED=true` y `BE_AT_POINTS > 0`, al alcanzar el trigger se cierra el 50% y el SL se mueve a break-even.

## Gestión de lotaje

| Parámetro | Valor |
|---|---|
| Lotaje mínimo | 0.1 lotes |
| Lotaje máximo | 20.0 lotes |
| Incremento | 0.1 lotes |

El tamaño de posición se calcula con la fórmula universal de forex usando el tick value real del símbolo consultado a MT5 al arrancar:

```
lotaje = riesgoUSD / (distanciaStop / tradeTickSize × tradeTickValue)
```

Para EURUSDm en cuenta USD: `tradeTickSize = 0.00001`, `tradeTickValue ≈ $1/lot/punto`.

**Ejemplo** (config actual: balance $10,000, `RISK_PERCENT=0.5`, SL a 15 pips):

```
riesgoUSD        = 10000 × 0.5 / 100        = $50
distanciaStop    = 0.0015                   (15 pips = 150 puntos)
riesgo por lote  = 0.0015 / 0.00001 × $1    = $150/lote
lotaje           = 50 / 150                 = 0.333 → 0.3 lotes (redondeado a 0.1)
```

El resultado se acota al rango `[0.1, 20.0]` lotes. El `tradeTickValue` real se consulta a MT5 al arrancar, así que el cálculo se ajusta automáticamente al símbolo y tipo de cuenta.

## Dashboard web

El bridge incluye un dashboard en `http://localhost:8001` con las siguientes secciones:

- **Estado del bridge** — conexión MT5 (verde / rojo)
- **Estado del bot** — semáforo en tiempo real con razón de bloqueo
- **Licencia** — visualizar y validar la clave de licencia
- **Configuración** — editar símbolo, riesgo, modo live, cooldown, instancia MT5, límites de pérdida y trades, filtros de entrada, gestión de posiciones, modo semi-automático. Hot-reload sin reiniciar el bot.
- **Telegram** — configurar token y chat ID, toggle de notificaciones, botón de prueba
- **Journal** — estadísticas (win rate, profit factor, avg R:R, P&L, rachas) + tabla de últimas 20 operaciones

## Hot-reload de configuración

Los cambios guardados desde el dashboard se escriben en `config.json`. El bot detecta el cambio automáticamente (sin reiniciar) vía `fs.watch`.

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Bot principal | TypeScript, Node.js, tsx |
| Bridge MT5 | Python, FastAPI, uvicorn |
| Broker | Exness — MetaTrader 5, símbolo `EURUSDm` |
| Notificaciones | Telegram Bot API |
| Licencias | Neon PostgreSQL |
| Validación | Zod (TS), Pydantic (Python) |
| Logger | Pino |
| Tests | Vitest |

## Requisitos

- Windows 10/11 o Windows Server (requerido por MetaTrader 5)
- Node.js 20+
- Python 3.11+
- MetaTrader 5 de Exness instalado y con sesión activa
- Bot de Telegram creado via [@BotFather](https://t.me/BotFather)

## Despliegue en producción (VPS / máquina dedicada)

Instala todo con un solo comando desde PowerShell **como Administrador**:

```powershell
# Opción A — desde el repo ya clonado:
.\install.ps1

# Opción B — máquina limpia (clona y configura todo automáticamente):
irm https://raw.githubusercontent.com/dnyvelasquez/eurusd-bot/main/install.ps1 | iex
```

El instalador:
1. Verifica e instala Node.js 20+ y Python 3.11+ (via winget si no están presentes)
2. Compila el bot TypeScript → `dist/`
3. Crea el entorno virtual Python e instala dependencias del bridge
4. Genera `.env` desde `.env.example` si no existe
5. Registra dos **Scheduled Tasks de Windows**:
   - `eurusd-bridge` — FastAPI/uvicorn en puerto 8001
   - `eurusd-bot` — motor de trading Node.js

| Comando | Acción |
|---|---|
| `.\start.ps1` | Inicia bridge + bot |
| `.\stop.ps1` | Detiene bot + bridge |
| `.\update.ps1` | `git pull` + rebuild + restart automático |

Los logs se guardan en `logs/` con rotación diaria:
- `logs\bridge-YYYY-MM-DD.log`
- `logs\bot-YYYY-MM-DD.log`

> **MT5:** abre MetaTrader 5 manualmente antes de ejecutar `start.ps1`. Configura `MT5_TERMINAL_PATH` en el dashboard si tienes varias instalaciones.

## Instalación para desarrollo local

```bash
git clone https://github.com/dnyvelasquez/eurusd-bot.git
cd eurusd-bot

npm install

python -m venv apps/mt5-bridge/.venv
apps\mt5-bridge\.venv\Scripts\activate
pip install -r apps/mt5-bridge/requirements.txt
```

## Configuración

Copia `.env.example` a `.env` en la raíz y completa los valores:

```env
NODE_ENV=production

TELEGRAM_BOT_TOKEN=tu_token_aqui
TELEGRAM_CHAT_ID=tu_chat_id_aqui

LICENSE_KEY=tu-uuid-de-licencia
DATABASE_URL=postgresql://...
```

Los parámetros de trading se gestionan en `config.json` (ver sección **Parámetros de configuración**).

> Pon `LIVE_TRADING=false` en `config.json` para modo paper (loggea setups sin ejecutar órdenes).

## Inicio en desarrollo

**1. Abrir MetaTrader 5** (Exness) con la cuenta activa y `EURUSDm` visible en el Market Watch.

**2. Arrancar el bridge** (terminal 1):
```bash
cd apps\mt5-bridge
.venv\Scripts\activate
uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

**3. Arrancar el bot** (terminal 2):
```bash
npm run dev
```

El dashboard queda disponible en `http://localhost:8001`.

## Scripts disponibles

```bash
npm run dev          # Modo desarrollo con hot-reload
npm run build        # Compilar para producción
npm start            # Ejecutar build de producción
npm run backtest     # Modo backtest (ver sección Backtest)
npm test             # Correr tests unitarios
npm run typecheck    # Verificar tipos TypeScript
npm run lint         # ESLint
```

## Backtest

Replaya velas históricas de MT5 contra la misma lógica de estrategia en vivo, sin arriesgar capital real.

### Requisitos

- El bridge de Python debe estar corriendo en puerto 8001.
- MetaTrader 5 debe estar abierto con la cuenta activa.
- Los datos M5 de EURUSDm están disponibles en MT5 desde ~enero 2025.

### Uso

```bash
# Con npm run — usar sintaxis key=value (sin doble dash) para pasar parámetros custom:
npm run backtest -- 2025-02-01 2025-12-31
npm run backtest -- 2025-02-01 2025-12-31 ep-adx-min=20 ep-adx-max=30 spread=0.0002

# Alternativa: tsx directamente (ambas sintaxis funcionan):
npx tsx -r tsconfig-paths/register src/backtest/index.ts --start 2025-02-01 --end 2025-12-31
```

> **Nota npm@10:** `npm run backtest -- --flag valor` no funciona porque npm interpreta los flags `--` como opciones propias y los descarta. Usar en su lugar `key=value` sin doble dash: `npm run backtest -- 2025-02-01 2025-12-31 ep-adx-min=20`

### Parámetros de backtest

| Parámetro | Default | Descripción |
|---|---|---|
| `--start` / `--end` | (requeridos) | Fechas en `YYYY-MM-DD` (como posicionales con npm) |
| `--symbol` | Desde config | Símbolo a testear (ej. `EURUSDm`) |
| `--balance` | `10000` | Balance inicial simulado en USD |
| `--risk` | Desde config | % de riesgo por trade |
| `--cooldown` | Desde config | Minutos de cooldown entre señales EP |
| `--spread` | Desde config | Spread en precio. Ej: `0.0001` = 1 pip |
| `--trail-rr` | Desde config | Trailing stop: distancia en múltiplos de slDist (`0` = desactivado) |
| `--rr` | `2` | Multiplicador de TP sobre slDist (2 = 2R) |
| `--ep-h4-align` | Desde config | Requerir alineación EMA H4 con H1 |
| `--ep-adx-max` | Desde config | ADX H4 máximo para señal EP (`0` = desactivado) |
| `--ci-max` | Desde config | CI H4 máximo para señal EP (`0` = desactivado) |
| `--max-daily-losses` | Desde config | Máximo de pérdidas por día |
| `--max-consec-loss-days` | Desde config | Días malos consecutivos antes de pausar semana |
| `--ep false` | — | Desactivar EMA Pullback |
| `--zb true` | — | Activar Zone Bounce |
| `--ec true` | — | Activar EMA Cross M15 |
| `--ec-h1 true` | — | Activar EMA Cross H1 |
| `--rt true` | — | Activar Range Mean Reversion |
| `--sb true` | — | Activar Session Breakout |
| `--fb true` | — | Activar Fibo Retracement |
| `--mo true` | — | Activar Momentum |
| `--regime true` | — | Conmutar por régimen (tendencia vs rango por CI) |

Los parámetros `BLOCKED_HOURS`, `MIN_FVG_POINTS`, `MIN_SL_POINTS`, `ZONE_PROXIMITY_POINTS`, `ZONE_SL_BUFFER_POINTS`, `EMA_SPREAD_MIN`, `EP_H4_ALIGN`, `EP_ADX_MAX`, `CI_MAX`, `TRAIL_RR`, `MAX_DAILY_LOSSES`, `MAX_CONSEC_LOSS_DAYS`, `BE_AT_POINTS`, `BE_BUFFER_POINTS`, `PARTIAL_TP_ENABLED` y `MAX_CONSEC_LOSSES` se leen automáticamente desde `config.json`.

### Fidelidad del backtest

| Aspecto | Comportamiento |
|---|---|
| Filtros activos | Session guard, cooldown, H4 align, ADX max, CI max, EMA spread mínimo, MACD M15 |
| Circuit breakers | MAX_DAILY_LOSSES, MAX_CONSEC_LOSS_DAYS, MAX_CONSEC_LOSSES |
| Trailing stop | Simulado barra a barra: SL avanza a trailRr × slDist detrás del precio pico |
| Break-even | Simulado cuando `BE_AT_POINTS > 0` |
| Entrada | Al cierre de vela M5 + spread simulado |
| SL/TP | Primera vela futura que toca el nivel; si ambos en la misma vela, SL tiene prioridad (pesimista) |
| News filter | No simulado — requeriría datos históricos de noticias |
| Warm-up | 5 días + 100 velas M5 previas a `--start` |

### Resultados de referencia (config actual)

Validado con `EP_H4_ALIGN=true`, `EP_ADX_MAX=25`, `CI_MAX=61.8`, `TRAIL_RR=1.5`, `MAX_DAILY_LOSSES=2`, `MAX_CONSEC_LOSS_DAYS=2`, `RISK_PERCENT=0.5`, `SPREAD_POINTS=0.0001`:

| Período | Trades | WR | PF | P&L | MaxDD | Racha |
|---|---|---|---|---|---|---|
| Feb–Dic 2025 (11 m) | 81 | 53.8% | 1.58 | +$1,123 | 2.48% | 5 |
| Ene–Jun 2026 (5 m) | 39 | 48.7% | 1.27 | +$275 | 3.45% | 7 |

*Cada período es un backtest independiente desde $10,000 — Riesgo: 0.5% por trade (~$50/trade).*

## Parámetros de configuración

Todos los parámetros `*_POINTS` se expresan en **unidades de precio raw** de EURUSD. Referencia: 1 pip = 0.0001, 1 punto = 0.00001.

### Filtros de señal EP

| Parámetro | Default | Equivalente | Descripción |
|---|---|---|---|
| `EP_H4_ALIGN` | `true` | — | Exige que EMA8 H4 esté alineada con la dirección H1 |
| `EP_ADX_MIN` | `0` | — | ADX H4 mínimo para señal EP (`0` = desactivado) |
| `EP_ADX_MAX` | `25` | — | ADX H4 máximo para señal EP (> 25 = trend sobreextendido, reversión probable) |
| `CI_MAX` | `61.8` | — | CI H4 máximo para señal EP (> 61.8 = mercado en rango choppy) |
| `EMA_SPREAD_MIN` | `0.0005` | 5 pips | Separación mínima EMA8/34 en H1 |
| `ZONE_PROXIMITY_POINTS` | `0.0015` | 15 pips | Proximidad al EMA34 M15 para entrada |
| `ZONE_SL_BUFFER_POINTS` | `0.0003` | 3 pips | Buffer del SL más allá de la EMA34 |
| `MIN_SL_POINTS` | `0.001` | 10 pips | Distancia mínima entry→SL |
| `MIN_FVG_POINTS` | `0.0002` | 2 pips | Tamaño mínimo del FVG en M5 |
| `EP_M15_ALIGN` | `false` | — | Exige EMA8 M15 al mismo lado que EMA34 |
| `EP_ADX_PERIOD` | `14` | — | Periodo para cálculo ADX en H4 |
| `SPREAD_POINTS` | `0.0001` | 1 pip | Spread bid-ask simulado en backtest y aplicado al entry en vivo |

### Circuit breakers de riesgo

| Parámetro | Default | Descripción |
|---|---|---|
| `SIGNAL_COOLDOWN_MINUTES` | `60` | Minutos mínimos entre señales EP de la misma dirección |
| `MAX_DAILY_LOSSES` | `2` | Máximo de pérdidas por día ET; al alcanzarse, pausa el resto del día |
| `MAX_CONSEC_LOSS_DAYS` | `0` | Días consecutivos con pérdida neta antes de pausar hasta el lunes (`0` = desactivado) |
| `MAX_CONSEC_LOSSES` | `0` | Pérdidas consecutivas antes de pausar el día (`0` = desactivado) |
| `MAX_DAILY_TRADES` | `0` | Máximo de trades por día (`0` = sin límite) |

### Gestión de posiciones

| Parámetro | Default | Descripción |
|---|---|---|
| `TRAIL_RR` | `1.5` | Trailing stop en múltiplos de slDist. Activa a 1.5R de ganancia, SL sigue a 1.5R detrás del precio. `0` = desactivado |
| `BE_AT_POINTS` | `0` | Distancia en precio para activar break-even (`0` = desactivado) |
| `BE_BUFFER_POINTS` | `0.00005` | Buffer sobre entry al mover SL a BE (0.5 pip) |
| `PARTIAL_TP_ENABLED` | `false` | Cierra 50% al trigger de BE (requiere `BE_AT_POINTS > 0`) |

### Generales

| Parámetro | Default | Descripción |
|---|---|---|
| `SYMBOL` | `EURUSDm` | Símbolo en MT5 (nombre exacto de Exness) |
| `RISK_PERCENT` | `0.5` | % del balance a arriesgar por trade |
| `LIVE_TRADING` | `false` | `true` para ejecutar órdenes reales |
| `ZB_ENABLED` | `false` | Activar estrategia Zone Bounce |
| `MT5_TERMINAL_PATH` | `""` | Ruta al ejecutable de MT5 (vacío = auto-detecta) |
| `TELEGRAM_ENABLED` | `false` | Activar notificaciones Telegram |
| `LICENSE_KEY` | — | UUID de licencia |
| `SEMI_AUTO_MODE` | `false` | Enviar alerta Telegram antes de ejecutar (requiere reinicio) |

## Endpoints del bridge

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/trading/health` | Estado de conexión MT5 |
| GET | `/api/trading/account` | Balance, equity y margen |
| GET | `/api/trading/symbol-info/{symbol}` | Tick size, tick value y contract size |
| GET | `/api/trading/candles/{symbol}/{timeframe}` | Últimas N velas |
| GET | `/api/trading/candles/{symbol}/{timeframe}/range` | Velas por rango de fechas |
| GET | `/api/trading/tick/{symbol}` | Tick actual (bid/ask) |
| GET | `/api/trading/positions/{symbol}` | Posiciones abiertas |
| PATCH | `/api/trading/positions/{ticket}` | Modificar SL/TP |
| POST | `/api/trading/positions/{ticket}/partial-close` | Cierre parcial |
| POST | `/api/trading/trade` | Colocar orden |
| GET | `/api/settings` | Leer configuración actual |
| PUT | `/api/settings` | Actualizar configuración |
| GET | `/api/license` | Leer licencia cacheada |
| POST | `/api/license/validate` | Validar clave de licencia |
| GET | `/api/telegram` | Leer credenciales Telegram |
| PUT | `/api/telegram` | Actualizar credenciales Telegram |
| POST | `/api/telegram/test` | Enviar mensaje de prueba |
| GET | `/api/journal/trades` | Últimas N operaciones del journal |
| GET | `/api/journal/stats` | Estadísticas: win rate, profit factor, avg R:R, P&L |

## Notificaciones Telegram

| Evento | Mensaje |
|---|---|
| Arranque | 🤖 Bot iniciado con símbolo, riesgo y modo |
| Mercado abierto | 🟢 Mercado abierto |
| Mercado cerrado | 🔴 Mercado cerrado |
| Setup paper | 📋 Setup validado con entry/SL/TP |
| Orden ejecutada | ✅ Orden colocada con ID y niveles |
| Orden fallida | ❌ Error con razón de MT5 |
| Break-even | 🔒 SL movido a precio de entrada |
| Partial TP | 📊 50% cerrado con precio y SL movido a BE |
| Trailing stop | 📈 SL actualizado |
| Semi-auto setup | 📋 Botones ✅ Ejecutar / ❌ Ignorar |
| Bridge caído | 🔌 Bridge MT5 desconectado |
| Bridge recuperado | ✅ Bridge MT5 reconectado |

## Semáforo de estado del bot

| Color | Estado |
|---|---|
| 🟢 Verde | Listo para operar |
| 🟡 Amarillo | Sesión cerrada (estado normal fuera de horario) |
| 🔴 Rojo | Bloqueado — muestra la razón exacta |
| ⚫ Gris | Bot no disponible (apagado o sin actividad > 30s) |

## Auto-reconexión al bridge

Si el bridge cae, el bot lo detecta en el siguiente ciclo (máximo 10s) y reintenta automáticamente cada 10s. Al reconectar notifica por Telegram y reanuda operación normal. En el arranque espera hasta 60 segundos (12 reintentos × 5s) antes de fallar.

## Trade Journal

Cada operación ejecutada en modo live se registra en la tabla `trades` de Neon PostgreSQL:

| Campo | Descripción |
|---|---|
| `ticket` | ID de la posición en MT5 |
| `side` / `volume` | Dirección y tamaño |
| `entry_price`, `stop_loss`, `take_profit` | Niveles de la operación |
| `planned_rr` | R:R calculado al abrir |
| `risk_amount` | Capital arriesgado en USD |
| `opened_at` / `closed_at` | Timestamps de apertura y cierre |
| `close_price` / `profit` | Precio de cierre y P&L |
| `actual_rr` | R:R realizado |
| `result` | `WIN`, `LOSS` o `BE` (break-even) |

Al cerrar cada operación también se inserta un registro en la tabla `trade_results` de Neon:

| Campo | Descripción |
|---|---|
| `owner_name` | Nombre del titular (desde `license-cache.json`) |
| `account_type` | `DEMO` o `REAL` |
| `mt5_account` | Número de cuenta MT5 |
| `bot_name` | `EURUSD Bot` |
| `symbol` | Activo operado |
| `profit_usd` | P&L en USD |
| `direction` | `LONG` o `SHORT` |
| `closed_at` | Timestamp UTC |
| `closed_at_et` | Fecha y hora de cierre en formato `YYYY-MM-DD HH:MM:SS` hora ET |

Estos datos se consultan desde **[bot-reports](https://bot-reports.vercel.app)** — dashboard centralizado con filtros por titular, cuenta, bot, activo y período (día/mes/año).

## Modo semi-automático

Cuando `SEMI_AUTO_MODE=true` y `LIVE_TRADING=true`, el bot envía por Telegram un mensaje con los niveles del trade y dos botones (✅ Ejecutar / ❌ Ignorar). Sin respuesta en 3 minutos, el trade se cancela. Requiere reiniciar el bot para activar/desactivar.

## Tests

```bash
npm test
```

Tests unitarios cubriendo los módulos principales de estrategia: `SwingDetector`, `FVGDetector`, `DisplacementDetector`, `EntryValidator`, `PositionMonitor`.
