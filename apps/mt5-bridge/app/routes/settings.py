import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

CONFIG_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / "config.json").resolve()


class BotSettings(BaseModel):
    SYMBOL: str = Field(default="SPX500")
    RISK_PERCENT: float = Field(default=1.0, ge=0.1, le=10.0)
    LIVE_TRADING: bool = Field(default=False)
    SIGNAL_COOLDOWN_MINUTES: int = Field(default=30, ge=1, le=1440)


def _read() -> BotSettings:
    if CONFIG_PATH.exists():
        return BotSettings(**json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return BotSettings()


@router.get("/settings", response_model=BotSettings)
def get_settings():
    return _read()


@router.put("/settings", response_model=BotSettings)
def update_settings(payload: BotSettings):
    try:
        CONFIG_PATH.write_text(
            json.dumps(payload.model_dump(), indent=2), encoding="utf-8"
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return payload
