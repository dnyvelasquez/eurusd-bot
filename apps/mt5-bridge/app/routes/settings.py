import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional
from urllib import request as urllib_req

import psycopg2
import psycopg2.extras
from dotenv import dotenv_values, set_key
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.mt5_client import MT5Client

router = APIRouter()

CONFIG_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / "config.json").resolve()
LICENSE_CACHE_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / "license-cache.json").resolve()
ENV_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / ".env").resolve()
BOT_STATUS_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / "bot-status.json").resolve()


# ── Bot trading status ────────────────────────────────────────────────────────

@router.get("/status")
def get_bot_status():
    try:
        data = json.loads(BOT_STATUS_PATH.read_text(encoding="utf-8"))
        updated = datetime.fromisoformat(data["updatedAt"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - updated).total_seconds()
        if age > 30:
            return {"available": False, "ready": False, "reason": "Bot sin actividad reciente", "age": round(age)}
        return {"available": True, "ready": data.get("ready", False), "reason": data.get("reason"), "age": round(age), "metrics": data.get("metrics")}
    except FileNotFoundError:
        return {"available": False, "ready": False, "reason": "Bot no disponible"}
    except Exception as exc:
        return {"available": False, "ready": False, "reason": str(exc)}


# ── Bot settings ──────────────────────────────────────────────────────────────

DEFAULT_BLOCKED_HOURS = [
    {"from": "09:30", "to": "09:35", "label": "NY Open"},
    {"from": "12:00", "to": "13:00", "label": "NY Lunch"},
    {"from": "15:45", "to": "16:00", "label": "NY Close"},
    {"from": "16:00", "to": "09:30", "label": "Out of market"},
]


class BlockedWindow(BaseModel):
    from_: str = Field(alias="from")
    to: str
    label: str

    model_config = {"populate_by_name": True}


class BotSettings(BaseModel):
    SYMBOL: str = Field(default="SPX500")
    RISK_PERCENT: float = Field(default=1.0, ge=0.1, le=10.0)
    LIVE_TRADING: bool = Field(default=False)
    SIGNAL_COOLDOWN_MINUTES: int = Field(default=30, ge=1, le=1440)
    MAX_DAILY_TRADES: int = Field(default=0, ge=0, le=50)
    MAX_CONSEC_LOSSES: int = Field(default=0, ge=0, le=10)
    MAX_CONSEC_LOSS_DAYS: int = Field(default=0, ge=0, le=10)
    TELEGRAM_ENABLED: bool = Field(default=True)
    LICENSE_KEY: str = Field(default="")
    BLOCKED_HOURS: List[BlockedWindow] = Field(default_factory=lambda: [BlockedWindow(**{"from": w["from"], "to": w["to"], "label": w["label"]}) for w in DEFAULT_BLOCKED_HOURS])
    MIN_SL_POINTS: float = Field(default=0.0, ge=0.0, le=500.0)
    MIN_FVG_POINTS: float = Field(default=0.0, ge=0.0, le=500.0)
    ZONE_PROXIMITY_POINTS: float = Field(default=20.0, ge=1.0, le=500.0)
    ZONE_SL_BUFFER_POINTS: float = Field(default=8.0, ge=0.0, le=100.0)
    EMA_SPREAD_MIN: float = Field(default=0.0, ge=0.0, le=200.0)
    EP_M15_ALIGN: bool = Field(default=True)
    EP_SKIP_MONDAY: bool = Field(default=False)
    EP_MIN_HOUR: int = Field(default=0, ge=0, le=23)
    EP_MAX_HOUR: int = Field(default=0, ge=0, le=23)
    EP_H4_ALIGN: bool = Field(default=False)
    EP_ADX_PERIOD: int = Field(default=14, ge=5, le=50)
    EP_ADX_MIN: float = Field(default=0.0, ge=0.0, le=100.0)
    BE_AT_POINTS: float = Field(default=0.0, ge=0.0, le=500.0)
    BE_BUFFER_POINTS: float = Field(default=0.25, ge=0.0, le=50.0)
    PARTIAL_TP_ENABLED: bool = Field(default=False)
    SEMI_AUTO_MODE: bool = Field(default=False)


def _read_config() -> BotSettings:
    if CONFIG_PATH.exists():
        return BotSettings(**json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return BotSettings()


@router.get("/settings", response_model=BotSettings)
def get_settings():
    return _read_config()


@router.put("/settings", response_model=BotSettings)
def update_settings(payload: BotSettings):
    try:
        CONFIG_PATH.write_text(json.dumps(payload.model_dump(by_alias=True), indent=2), encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return payload


# ── License ───────────────────────────────────────────────────────────────────

class LicenseInfo(BaseModel):
    owner_name: str
    mt5_account: int
    trade_mode: str
    allowed_mode: str
    active: bool
    expires_at: Optional[str] = None
    validated_at: str


class ValidateRequest(BaseModel):
    license_key: str = Field(min_length=36, max_length=36)


class ValidateResponse(BaseModel):
    valid: bool
    reason: Optional[str] = None
    owner_name: Optional[str] = None
    mt5_account: Optional[int] = None
    allowed_mode: Optional[str] = None
    expires_at: Optional[str] = None


@router.get("/license", response_model=LicenseInfo)
def get_license():
    if not LICENSE_CACHE_PATH.exists():
        raise HTTPException(status_code=404, detail="License not validated yet — start the bot first")
    try:
        return LicenseInfo(**json.loads(LICENSE_CACHE_PATH.read_text(encoding="utf-8")))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/license/validate", response_model=ValidateResponse)
def validate_license(body: ValidateRequest):
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=503, detail="DATABASE_URL not configured in .env")

    # ── 1. Obtener cuenta MT5 activa ──────────────────────────────────────────
    if not MT5Client.connect():
        raise HTTPException(status_code=503, detail="MT5 not connected")

    account = MT5Client.get_account_info()
    if not account:
        raise HTTPException(status_code=503, detail="Cannot retrieve MT5 account info")

    mt5_login = account["login"]
    trade_mode = account["tradeMode"]

    # ── 2. Consultar Neon ─────────────────────────────────────────────────────
    try:
        conn = psycopg2.connect(db_url, cursor_factory=psycopg2.extras.RealDictCursor, connect_timeout=5)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Cannot connect to database: {exc}") from exc

    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT owner_name, mt5_account, allowed_mode, active, expires_at "
                "FROM licenses WHERE license_key = %s::uuid LIMIT 1",
                (body.license_key,),
            )
            row = cur.fetchone()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()

    # ── 3. Validar ────────────────────────────────────────────────────────────
    if not row:
        return ValidateResponse(valid=False, reason="Clave de licencia no encontrada")

    row = dict(row)

    if not row["active"]:
        return ValidateResponse(valid=False, reason="La licencia está inactiva")

    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
        return ValidateResponse(valid=False, reason=f"La licencia venció el {row['expires_at'].date()}")

    if int(row["mt5_account"]) != mt5_login:
        return ValidateResponse(
            valid=False,
            reason=f"Cuenta incorrecta — la licencia es para la cuenta {row['mt5_account']}, conectada: {mt5_login}",
        )

    mode_ok = (
        row["allowed_mode"] == "both"
        or (row["allowed_mode"] == "demo" and trade_mode in ("DEMO", "CONTEST"))
        or (row["allowed_mode"] == "live" and trade_mode == "REAL")
    )
    if not mode_ok:
        return ValidateResponse(
            valid=False,
            reason=f"La licencia solo permite modo '{row['allowed_mode']}', cuenta actual: {trade_mode}",
        )

    # ── 4. Guardar en config.json ─────────────────────────────────────────────
    cfg = _read_config().model_dump(by_alias=True)
    cfg["LICENSE_KEY"] = body.license_key
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    expires_str = str(row["expires_at"]) if row["expires_at"] else None

    # ── 5. Actualizar license-cache.json ──────────────────────────────────────
    cache = {
        "owner_name": row["owner_name"],
        "mt5_account": mt5_login,
        "trade_mode": trade_mode,
        "allowed_mode": row["allowed_mode"],
        "active": row["active"],
        "expires_at": expires_str,
        "validated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        LICENSE_CACHE_PATH.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    except Exception:
        pass

    return ValidateResponse(
        valid=True,
        owner_name=row["owner_name"],
        mt5_account=mt5_login,
        allowed_mode=row["allowed_mode"],
        expires_at=expires_str,
    )


# ── Telegram ──────────────────────────────────────────────────────────────────

class TelegramConfig(BaseModel):
    token: str = Field(default="")
    chat_id: str = Field(default="")


class TelegramTestResult(BaseModel):
    success: bool
    detail: str


def _read_telegram() -> TelegramConfig:
    values = dotenv_values(str(ENV_PATH))
    return TelegramConfig(
        token=values.get("TELEGRAM_BOT_TOKEN", ""),
        chat_id=values.get("TELEGRAM_CHAT_ID", ""),
    )


@router.get("/telegram", response_model=TelegramConfig)
def get_telegram():
    return _read_telegram()


@router.put("/telegram", response_model=TelegramConfig)
def update_telegram(payload: TelegramConfig):
    if not payload.token:
        raise HTTPException(status_code=400, detail="El token no puede estar vacío")
    set_key(str(ENV_PATH), "TELEGRAM_BOT_TOKEN", payload.token)
    set_key(str(ENV_PATH), "TELEGRAM_CHAT_ID", payload.chat_id)
    return payload


@router.post("/telegram/test", response_model=TelegramTestResult)
def test_telegram():
    cfg = _read_telegram()
    if not cfg.token or not cfg.chat_id:
        return TelegramTestResult(success=False, detail="Token o Chat ID no configurados")

    url = f"https://api.telegram.org/bot{cfg.token}/sendMessage"
    body = json.dumps({
        "chat_id": cfg.chat_id,
        "text": "🤖 SPX500 Bot — prueba de conexión Telegram exitosa",
        "parse_mode": "HTML",
    }).encode()

    try:
        req = urllib_req.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib_req.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                return TelegramTestResult(success=True, detail="Mensaje enviado correctamente")
            return TelegramTestResult(success=False, detail=result.get("description", "Error desconocido"))
    except Exception as exc:
        return TelegramTestResult(success=False, detail=str(exc))
