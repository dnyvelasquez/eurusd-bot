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
    {"from": "17:00", "to": "03:00", "label": "Asian session (low liquidity)"},
]


class BlockedWindow(BaseModel):
    from_: str = Field(alias="from")
    to: str
    label: str

    model_config = {"populate_by_name": True}


class BotSettings(BaseModel):
    """Solo parámetros operativos editables desde el dashboard.

    Los parámetros de estrategia/riesgo validados en los backtests (filtros,
    señales, SL/FVG, EP, ADX, CI, trailing, BE, cooldown, horarios, guards)
    NO se exponen aquí a propósito: viven solo en config.json y se preservan
    al guardar (ver update_settings). Así no se puede modificar desde el panel
    lo que ya funcionó en las pruebas.
    """
    RISK_PERCENT: float = Field(default=0.5, ge=0.1, le=10.0)
    LIVE_TRADING: bool = Field(default=False)
    TELEGRAM_ENABLED: bool = Field(default=True)
    LICENSE_KEY: str = Field(default="")
    MT5_TERMINAL_PATH: str = Field(default="")

    model_config = {"extra": "ignore"}


def _read_config() -> BotSettings:
    if CONFIG_PATH.exists():
        return BotSettings(**json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return BotSettings()


@router.get("/settings", response_model=BotSettings)
def get_settings():
    return _read_config()


@router.put("/settings", response_model=BotSettings)
def update_settings(payload: BotSettings):
    """Merge editable fields into config.json, preserving locked strategy keys."""
    try:
        existing = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
        existing.update(payload.model_dump(by_alias=True, exclude_unset=True))
        CONFIG_PATH.write_text(json.dumps(existing, indent=2), encoding="utf-8")
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
        "text": "🤖 EURUSD Bot — prueba de conexión Telegram exitosa",
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
