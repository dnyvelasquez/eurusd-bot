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
│    ├─ DailyDrawdownGuard     (límite % pérdida diaria)  │
│    ├─ DailyTradeCountGuard   (máximo trades por día)    │
│    ├─ DailyLossGuard         (máximo pérdidas por día)  │
│    └─ ConsecLossGuard        (circuit breaker semanal)  │
│                                                          │
│  TradeJournalService  (registro de operaciones en DB)   │
│  BotStatusService     (semáforo en tiempo real)         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Telegram Bot  (notificaciones)              │
└─────────────────────────────────────────────────────────┘
```

## Estrategia activa: EMA Pullback [EP]

El bot opera una única estrategia: **EMA Pullback** sobre EURUSDm en Exness. La señal se evalúa en cada vela M5 cerrada dentro del horario de sesión.

### Lógica de entrada

1. **Alineación top-down H4 → H1** — `EP_H4_ALIGN=true`: EMA8 H4 debe estar al mismo lado de EMA34 que la dirección H1. Filtra entradas contratendencia en HTF.

2. **Tendencia H1 confirmada** — EMA8 > EMA34 en H1 → BULLISH; EMA8 < EMA34 → BEARISH. La separación entre EMAs debe ser ≥ `EMA_SPREAD_MIN` (5 pips) para evitar mercados choppy.

3. **Régimen de mercado (Choppiness Index)** — si el CI en H4 supera `CI_MAX` (61.8), el mercado está en rango y la señal se descarta. Evita entradas en mercados sin tendencia.

4. **ADX moderado** — si el ADX en H4 supera `EP_ADX_MAX` (25), la tendencia está sobreextendida y la señal se descarta. El EMA Pullback funciona mejor en tendencias moderadas (ADX < 25).

5. **Precio cerca de EMA34 en M15** — el precio actual debe estar dentro de `ZONE_PROXIMITY_POINTS` de la EMA34 en M15 (zona dinámica de soporte/resistencia).

6. **MACD confirma momentum** — el histograma MACD en M15 debe estar en la dirección del trade (>0 para BULLISH, <0 para BEARISH).

7. **Entrada y niveles** — el SL va más allá de la EMA34 en M15 (`ZONE_SL_BUFFER_POINTS`). El TP garantiza mínimo 2:1 R:R.

### Estrategias adicionales (desactivadas por defecto)

El backtest incluye implementaciones de estrategias experimentales que pueden activarse por CLI:

| Flag | Estrategia | Descripción |
|---|---|---|
| `--zb true` | Zone Bounce [ZB] | Rebote en zonas HTF D1/H4/H1/M15 con sesgo multi-TF |
| `--ec true` | EMA Cross M15 [EC] | Cruce de EMA 8/34 en M15 con confirmación H4 |
| `--ec-h1 true` | EMA Cross H1 [EH] | Cruce de EMA 8/34 en H1 con confirmación H4 |
| `--rt true` | Range Mean Rev [RT] | Fade de extremos M15 en mercados choppy (CI > umbral) |
| `--sb true` | Session Breakout [SB] | Breakout del rango asiático en apertura de Londres |

> Estas estrategias tienen cooldown independiente del EP y no afectan su señal.

## Filtros de riesgo

| Filtro | Comportamiento |
|---|---|
| **News filter** | Bloquea señales ±1 minuto alrededor de noticias EUR/USD de alto impacto (Forex Factory). Se refresca cada día a medianoche UTC. |
| **Session guard** | Bloquea señales fuera de las ventanas horarias permitidas. Usa hora ET con soporte automático de DST. |
| **Daily loss limit** | Si el número de pérdidas del día alcanza `MAX_DAILY_LOSSES` (2), no se abren más posiciones hasta el día siguiente. |
| **Consecutive bad days** | Si se cierran `MAX_CONSEC_LOSS_DAYS` (2) días consecutivos con pérdida neta, el bot pausa hasta el lunes siguiente. |
| **Daily drawdown** | Si la pérdida del día supera `MAX_DAILY_DRAWDOWN_PERCENT`, no se abren más posiciones hasta el día siguiente. |
| **Daily trade limit** | Si el número de trades del día alcanza `MAX_DAILY_TRADES`, no se abren más posiciones. `0` = sin límite. |
| **Consecutive loss circuit** | Si se cierran `MAX_CONSEC_LOSSES` pérdidas seguidas en el mismo día ET, bloquea el resto del día. `0` = desactivado. |
| **Signal cooldown** | Mínimo `SIGNAL_COOLDOWN_MINUTES` (60 min) entre señales EP para evitar re-entradas. |

### Ventanas bloqueadas por defecto (hora ET)

| Ventana | Horario | Razón |
|---|---|---|
| Asian session | 17:00 – 03:00 | Baja liquidez en EUR/USD |

El bot opera durante las sesiones de **Londres** (03:00 – 12:00 ET) y **Nueva York** (08:00 – 17:00 ET).

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
# Recomendado: llamar tsx directamente (evita que npm intercepte los flags)
node_modules\.bin\tsx -r tsconfig-paths/register src/backtest/index.ts 2025-02-01 2025-12-31

# También funciona con npm run (las fechas se pasan como posicionales):
npm run backtest -- 2025-02-01 2025-12-31
```

> **Nota sobre spread:** El parámetro `SPREAD_POINTS` en `config.json` debe estar definido explícitamente. El default interno de 0.35 es incorrecto para EURUSD (equivaldría a 3500 pips). El valor correcto para EURUSDm en Exness es `0.0001` (1 pip).

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

Validado con `EP_H4_ALIGN=true`, `EP_ADX_MAX=25`, `CI_MAX=61.8`, `TRAIL_RR=1.5`, `MAX_DAILY_LOSSES=2`, `MAX_CONSEC_LOSS_DAYS=2`:

| Período | Trades | WR | PF | P&L | MaxDD | Racha |
|---|---|---|---|---|---|---|
| Feb–Dic 2025 (11 m) | 105 | 49.0% | 1.23 | +$120 | 0.84% | 5 |
| Ene–Jun 2026 (5 m) | 46 | 50.0% | 1.43 | +$99 | 0.67% | 4 |
| **Total 16 meses** | 151 | — | — | **+$219** | <1% | — |

*Balance inicial: $10,000 — Riesgo: 0.1% por trade ($10/trade)*

## Parámetros de configuración

Todos los parámetros `*_POINTS` se expresan en **unidades de precio raw** de EURUSD. Referencia: 1 pip = 0.0001, 1 punto = 0.00001.

### Filtros de señal EP

| Parámetro | Default | Equivalente | Descripción |
|---|---|---|---|
| `EP_H4_ALIGN` | `true` | — | Exige que EMA8 H4 esté alineada con la dirección H1 |
| `EP_ADX_MAX` | `25` | — | Salta señales cuando ADX H4 > 25 (trend sobreextendido) |
| `CI_MAX` | `61.8` | — | Salta señales cuando CI H4 > 61.8 (mercado en rango) |
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
| `MAX_CONSEC_LOSS_DAYS` | `2` | Días consecutivos con pérdida neta; al alcanzarse, pausa hasta el lunes |
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
| `RISK_PERCENT` | `0.1` | % del balance a arriesgar por trade |
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

## Modo semi-automático

Cuando `SEMI_AUTO_MODE=true` y `LIVE_TRADING=true`, el bot envía por Telegram un mensaje con los niveles del trade y dos botones (✅ Ejecutar / ❌ Ignorar). Sin respuesta en 3 minutos, el trade se cancela. Requiere reiniciar el bot para activar/desactivar.

## Tests

```bash
npm test
```

Tests unitarios cubriendo los módulos principales de estrategia: `SwingDetector`, `FVGDetector`, `DisplacementDetector`, `EntryValidator`, `PositionMonitor`.
