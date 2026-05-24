import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.mt5_client import MT5Client

router = APIRouter()

CONFIG_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / "config.json").resolve()
LICENSE_CACHE_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / "license-cache.json").resolve()


# ── Bot settings ──────────────────────────────────────────────────────────────

class BotSettings(BaseModel):
    SYMBOL: str = Field(default="SPX500")
    RISK_PERCENT: float = Field(default=1.0, ge=0.1, le=10.0)
    LIVE_TRADING: bool = Field(default=False)
    SIGNAL_COOLDOWN_MINUTES: int = Field(default=30, ge=1, le=1440)
    LICENSE_KEY: str = Field(default="")


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
        CONFIG_PATH.write_text(json.dumps(payload.model_dump(), indent=2), encoding="utf-8")
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
        conn = psycopg2.connect(db_url, cursor_factory=psycopg2.extras.RealDictCursor)
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
    cfg = _read_config().model_dump()
    cfg["LICENSE_KEY"] = body.license_key
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    expires_str = str(row["expires_at"]) if row["expires_at"] else None

    return ValidateResponse(
        valid=True,
        owner_name=row["owner_name"],
        mt5_account=mt5_login,
        allowed_mode=row["allowed_mode"],
        expires_at=expires_str,
    )
