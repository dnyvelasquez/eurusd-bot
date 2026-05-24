# SPX500 Bot

Bot de trading algorítmico para el S&P 500 basado en conceptos ICT / Smart Money. Analiza el mercado en tiempo real, detecta setups de alta probabilidad y ejecuta órdenes automáticamente a través de MetaTrader 5.

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                    MetaTrader 5                          │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              mt5-bridge  (Python / FastAPI)              │
│  /health  /account  /candles  /positions  /trade        │
│  /settings  /license  /telegram                         │
│  Dashboard web  →  http://localhost:8000                 │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────────┐
│                  bot-core  (TypeScript)                  │
│                                                          │
│  MarketDataService → StrategyEngine                      │
│    ├─ LiquidityEngine  (niveles BSL/SSL + sweeps)        │
│    ├─ BiasEngine       (sesgo HTF en H1)                 │
│    ├─ FVGEngine        (Fair Value Gaps en M5)           │
│    ├─ MSSDetector      (Market Structure Shift)          │
│    ├─ EntryValidator   (5 condiciones ICT)               │
│    ├─ PositionSizing   (riesgo % del balance)            │
│    └─ PositionMonitor  (break-even + trailing stop)      │
│                                                          │
│  Filtros de riesgo (se evalúan antes de cada orden)      │
│    ├─ NewsFilterService      (bloqueo ±1 min noticias)   │
│    ├─ SessionGuard           (horarios bloqueados en ET) │
│    ├─ DailyDrawdownGuard     (límite % pérdida diaria)   │
│    ├─ DailyProfitTargetGuard (objetivo % ganancia diaria)│
│    ├─ WeeklyDrawdownGuard    (límite % pérdida semanal)  │
│    └─ DailyTradeCountGuard   (máximo trades por día)     │
│                                                          │
│  TradeJournalService  (registro de operaciones en DB)    │
│  BotStatusService     (semáforo en tiempo real)          │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Telegram Bot  (notificaciones)              │
└─────────────────────────────────────────────────────────┘
```

## Lógica de entrada

El bot requiere **5 condiciones simultáneas** antes de abrir una posición:

1. **Sesgo HTF alineado** — BiasEngine detecta BOS/CHOCH en H1
2. **Sweep de liquidez** — precio toma stops por encima/debajo de un nivel BSL/SSL
3. **Market Structure Shift (MSS)** — rotura de estructura en dirección contraria al sweep
4. **Desplazamiento** — vela M5 con cuerpo ≥ 70% del rango
5. **Fair Value Gap (FVG)** — imbalance de precio en las últimas 3 velas M5

La entrada se coloca en el midpoint del FVG (o al precio de mercado si no hay FVG). El SL va más allá del extremo de la vela del sweep y el TP garantiza mínimo 2:1 R:R.

## Filtros de riesgo

Antes de ejecutar cualquier orden, el bot pasa por cuatro filtros en este orden:

| Filtro | Comportamiento |
|---|---|
| **News filter** | Bloquea señales ±1 minuto alrededor de noticias USD de alto impacto (Forex Factory). Se refresca cada día a medianoche UTC. |
| **Session guard** | Bloquea señales fuera de las ventanas horarias permitidas (ver tabla abajo). Usa hora ET con soporte automático de DST. |
| **Daily drawdown** | Si la pérdida del día supera `MAX_DAILY_DRAWDOWN_PERCENT` (default 3%), no se abren más posiciones hasta el día siguiente. |
| **Daily profit target** | Si la ganancia del día supera `MAX_DAILY_PROFIT_PERCENT` (default 3%), no se abren más posiciones. Protege las ganancias. |
| **Weekly drawdown** | Si la pérdida de la semana supera `MAX_WEEKLY_DRAWDOWN_PERCENT` (default 5%), no se abren posiciones hasta el lunes siguiente. Referencia se resetea cada lunes. |
| **Daily trade limit** | Si el número de trades del día alcanza `MAX_DAILY_TRADES`, no se abren más posiciones. `0` = sin límite (default). Se resetea automáticamente a medianoche UTC. |
| **Signal cooldown** | Mínimo `SIGNAL_COOLDOWN_MINUTES` (default 30) entre señales del mismo tipo para evitar sobreoperación. |

### Ventanas bloqueadas por defecto (hora ET)

| Ventana | Horario | Razón |
|---|---|---|
| NY Open | 09:30 – 09:35 | Spike de volatilidad, stops hunts erráticos, estructura sucia |
| NY Lunch | 12:00 – 13:00 | Volumen cae ~40%, precio choppea sin dirección |
| NY Close | 15:45 – 16:00 | Cierre de posiciones del día, movimientos artificiales |
| Out of market | 16:00 – 09:30 | Sin volumen institucional (pre/post market) |

Las ventanas son configurables en `config.json` bajo la clave `BLOCKED_HOURS` y soportan hot-reload desde el dashboard sin reiniciar el bot. Formato de cada ventana:

```json
"BLOCKED_HOURS": [
  { "from": "09:30", "to": "09:35", "label": "NY Open" },
  { "from": "12:00", "to": "13:00", "label": "NY Lunch" },
  { "from": "15:45", "to": "16:00", "label": "NY Close" },
  { "from": "16:00", "to": "09:30", "label": "Out of market" }
]
```

> Las ventanas que cruzan medianoche (como `16:00–09:30`) se detectan automáticamente.

## Gestión de lotaje

| Parámetro | Valor |
|---|---|
| Lotaje mínimo | 0.1 lotes |
| Lotaje máximo | 20.0 lotes |
| Incremento | 0.1 lotes (1 decimal) |

El tamaño de posición se calcula en base al riesgo porcentual del balance y se redondea al múltiplo de 0.1 más cercano dentro del rango permitido.

## Dashboard web

El bridge incluye un dashboard en `http://localhost:8000` con las siguientes secciones:

- **Estado** — balance, equity y conexión MT5
- **Configuración** — editar símbolo, riesgo, modo live, cooldown, límites de pérdida diaria/semanal/semanal y objetivo de ganancia diaria — cada campo con barra de progreso (verde → amarillo → rojo). Máximo de trades diarios con gauge. Toggles de TPs parciales y confirmación M15. Filtro de tamaño mínimo de FVG. Hot-reload sin reiniciar el bot.
- **Licencia** — visualizar y validar la clave de licencia
- **Telegram** — configurar token y chat ID, botón de prueba de envío

## Hot-reload de configuración

Los cambios guardados desde el dashboard se escriben en `config.json` en la raíz. El bot detecta el cambio automáticamente (sin reiniciar) vía `fs.watch`. Los parámetros con soporte hot-reload son:

`SYMBOL`, `RISK_PERCENT`, `LIVE_TRADING`, `SIGNAL_COOLDOWN_MINUTES`, `MAX_DAILY_DRAWDOWN_PERCENT`, `MAX_DAILY_PROFIT_PERCENT`, `MAX_WEEKLY_DRAWDOWN_PERCENT`, `MAX_DAILY_TRADES`, `MIN_FVG_POINTS`, `PARTIAL_TP_ENABLED`, `M15_CONFIRMATION_ENABLED`, `TELEGRAM_ENABLED`, `LICENSE_KEY`, `BLOCKED_HOURS`

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Bot principal | TypeScript, Node.js, tsx |
| Bridge MT5 | Python, FastAPI, uvicorn |
| Broker | MetaTrader 5 |
| Notificaciones | Telegram Bot API |
| Licencias | Neon PostgreSQL |
| Validación | Zod (TS), Pydantic (Python) |
| Logger | Pino |
| Tests | Vitest |

## Requisitos

- Node.js 18+
- Python 3.10+
- MetaTrader 5 instalado y con sesión activa
- Bot de Telegram creado via [@BotFather](https://t.me/BotFather)

## Instalación

```bash
# Clonar el repositorio
git clone https://github.com/dnyvelasquez/spx500-bot.git
cd spx500-bot

# Dependencias Node.js
npm install

# Entorno virtual Python
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Linux/Mac

pip install -r apps/mt5-bridge/requirements.txt
```

## Configuración

Crear `.env` en la raíz del proyecto:

```env
NODE_ENV=development

TELEGRAM_BOT_TOKEN=tu_token_aqui
TELEGRAM_CHAT_ID=tu_chat_id_aqui

SYMBOL=SPX500
RISK_PERCENT=1
LIVE_TRADING=false

SIGNAL_COOLDOWN_MINUTES=30

LICENSE_KEY=tu-uuid-de-licencia

DATABASE_URL=postgresql://...
```

> Para obtener tu `TELEGRAM_CHAT_ID`: envía un mensaje al bot y visita
> `https://api.telegram.org/bot{TOKEN}/getUpdates`

> Pon `LIVE_TRADING=false` para modo paper (loggea setups sin ejecutar órdenes).

## Inicio

**1. Abrir MetaTrader 5** con la cuenta activa y `SPX500` visible en el Market Watch.

**2. Arrancar el bridge** (terminal 1):
```bash
.venv\Scripts\activate
cd apps\mt5-bridge
uvicorn app.main:app --reload
```

**3. Arrancar el bot** (terminal 2):
```bash
npm run dev
```

El dashboard queda disponible en `http://localhost:8000`.

## Scripts disponibles

```bash
npm run dev          # Modo desarrollo con hot-reload
npm run build        # Compilar para producción
npm start            # Ejecutar build de producción
npm test             # Correr tests unitarios
npm run test:watch   # Tests en modo watch
npm run typecheck    # Verificar tipos TypeScript
npm run lint         # ESLint
```

## Endpoints del bridge

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/trading/health` | Estado de conexión MT5 |
| GET | `/api/trading/account` | Balance, equity y margen |
| GET | `/api/trading/candles/{symbol}/{timeframe}` | Velas históricas |
| GET | `/api/trading/positions/{symbol}` | Posiciones abiertas |
| PATCH | `/api/trading/positions/{ticket}` | Modificar SL/TP |
| POST | `/api/trading/positions/{ticket}/partial-close` | Cierre parcial de posición (TPs parciales) |
| POST | `/api/trading/trade` | Colocar orden |
| GET | `/api/settings` | Leer configuración actual |
| PUT | `/api/settings` | Actualizar configuración |
| GET | `/api/license` | Leer licencia cacheada |
| POST | `/api/license/validate` | Validar clave de licencia |
| GET | `/api/telegram` | Leer credenciales Telegram |
| PUT | `/api/telegram` | Actualizar credenciales Telegram |
| POST | `/api/telegram/test` | Enviar mensaje de prueba |
| GET | `/api/trading/history/{ticket}` | Historial de cierre de una posición |
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
| Semi-auto setup | 📋 Botones ✅ Ejecutar / ❌ Ignorar con niveles del trade |
| Trailing stop | 📈 SL actualizado |
| Bridge caído | 🔌 Bridge MT5 desconectado |
| Bridge recuperado | ✅ Bridge MT5 reconectado |

## Filtros de estrategia (opcionales)

| Filtro | Parámetro | Comportamiento |
|---|---|---|
| **Tamaño mínimo de FVG** | `MIN_FVG_POINTS` | Ignora FVGs cuyo gap sea menor al valor en puntos. `0` = desactivado. |
| **Confirmación M15** | `M15_CONFIRMATION_ENABLED` | Exige que el sesgo en M15 (calculado con BiasEngine) esté alineado con el sesgo H1 antes de entrar. Reduce falsos setups. |

## Gestión de posiciones

Una vez abierta una posición, el bot la monitorea en cada ciclo de sync (10s):

- **Break-even** — cuando el precio se mueve 1R a favor, el SL se mueve al precio de entrada (operación sin riesgo). Solo cuando `PARTIAL_TP_ENABLED=false`.
- **Partial TP** (opcional) — cuando `PARTIAL_TP_ENABLED=true` y el precio se mueve 1R a favor: se cierra el 50% de la posición y el SL se mueve a break-even. El 50% restante sigue corriendo.
- **Trailing stop** — cuando el precio se mueve 2R a favor, el SL sigue al precio manteniéndose a 1R de distancia.

## Semáforo de estado del bot

El dashboard muestra en tiempo real si el bot puede operar y por qué está bloqueado:

| Color | Estado |
|---|---|
| 🟢 Verde | Listo para operar |
| 🟡 Amarillo | Mercado cerrado (estado normal fuera de horario) |
| 🔴 Rojo | Bloqueado — muestra la razón exacta |
| ⚫ Gris | Bot no disponible (apagado o sin actividad > 30s) |

Razones posibles de bloqueo: horario bloqueado (NY Open / Lunch / Close / fuera de mercado), noticia USD de alto impacto, límite de pérdida diaria, objetivo de ganancia diaria, límite de pérdida semanal, cooldown activo.

El bot escribe `bot-status.json` en cada ciclo de sync (10s). El dashboard lo consulta cada 10s vía `GET /api/status`. Las barras de progreso de los límites se actualizan al mismo tiempo.

## Trade Journal

Cada operación ejecutada en modo live se registra automáticamente en la tabla `trades` de Neon PostgreSQL:

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

Las estadísticas (win rate, profit factor, avg R:R, P&L total, racha máxima y actual de pérdidas consecutivas) se visualizan en tiempo real en el dashboard bajo la sección **Journal**, con actualización automática cada 30 segundos.

## Modo semi-automático

Cuando `SEMI_AUTO_MODE=true` y `LIVE_TRADING=true`, el bot detecta el setup completo (todas las condiciones ICT) y en lugar de ejecutar automáticamente envía por Telegram un mensaje con los niveles del trade y dos botones:

- **✅ Ejecutar** — coloca la orden en MT5 inmediatamente
- **❌ Ignorar** — descarta el setup

Si no hay respuesta en **3 minutos**, el trade se cancela automáticamente y el mensaje se actualiza indicando que expiró. Útil para usuarios que quieren supervisar las entradas sin perder las señales.

> Requiere reiniciar el bot para activar/desactivar el polling de Telegram.

## Tests

```bash
npm test
```

26 tests unitarios cubriendo los módulos principales de estrategia:
- `SwingDetector` — detección de swing highs y lows
- `FVGDetector` — Fair Value Gaps alcistas y bajistas
- `DisplacementDetector` — fuerza del desplazamiento
- `EntryValidator` — validación de las 5 condiciones ICT
- `PositionMonitor` — lógica de break-even y trailing stop

## Variables de entorno

| Variable | Descripción | Default |
|---|---|---|
| `SYMBOL` | Símbolo en MT5 | `SPX500` |
| `RISK_PERCENT` | % del balance a arriesgar por trade | `1` |
| `LIVE_TRADING` | `true` para ejecutar órdenes reales | `false` |
| `SIGNAL_COOLDOWN_MINUTES` | Minutos entre señales del mismo tipo | `30` |
| `MAX_DAILY_DRAWDOWN_PERCENT` | % máximo de pérdida diaria permitida | `3` |
| `MAX_DAILY_PROFIT_PERCENT` | % objetivo de ganancia diaria (para al alcanzarlo) | `3` |
| `MAX_WEEKLY_DRAWDOWN_PERCENT` | % máximo de pérdida semanal permitida (resetea el lunes) | `5` |
| `MAX_DAILY_TRADES` | Máximo de trades por día (`0` = sin límite) | `0` |
| `MIN_FVG_POINTS` | Tamaño mínimo del FVG en puntos para aceptar la entrada (`0` = sin filtro) | `0` |
| `PARTIAL_TP_ENABLED` | `true` para cerrar 50% en 1R y dejar correr el resto | `false` |
| `M15_CONFIRMATION_ENABLED` | `true` para exigir sesgo M15 alineado con H1 antes de entrar | `false` |
| `SEMI_AUTO_MODE` | `true` para enviar alerta de Telegram con botones antes de ejecutar (requiere reinicio) | `false` |
| `TELEGRAM_ENABLED` | `false` para silenciar notificaciones | `true` |
| `LICENSE_KEY` | UUID de licencia (también editable en dashboard) | — |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram | — |
| `TELEGRAM_CHAT_ID` | Chat ID para notificaciones | — |
| `DATABASE_URL` | Conexión Neon PostgreSQL para validación de licencias | — |
