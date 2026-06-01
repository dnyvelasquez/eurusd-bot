from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel
from app.core.mt5_client import MT5Client
from app.core.mt5_client import TIMEFRAMES

router = APIRouter()


@router.get("/health")
def health():

    connected = MT5Client.connect()

    return {
        "success": connected,
        "mt5_connected": connected
    }


@router.get("/account")
def get_account():

    connected = MT5Client.connect()

    if not connected:
        return {
            "success": False,
            "message": "MT5 not connected"
        }

    info = MT5Client.get_account_info()

    if info is None:
        return {
            "success": False,
            "message": "Could not retrieve account info"
        }

    return {
        "success": True,
        "data": info
    }


@router.get("/positions/{symbol}")
def get_positions(symbol: str):

    connected = MT5Client.connect()

    if not connected:
        return {
            "success": False,
            "message": "MT5 not connected"
        }

    positions = MT5Client.get_positions(symbol)

    return {
        "success": True,
        "data": positions
    }


@router.get("/symbol-info/{symbol}")
def get_symbol_info(symbol: str):
    connected = MT5Client.connect()
    if not connected:
        return {"success": False, "message": "MT5 not connected"}
    info = MT5Client.get_symbol_info(symbol)
    if info is None:
        return {"success": False, "message": f"Symbol {symbol} not found"}
    return {"success": True, "symbol": symbol, "data": info}


@router.get("/tick/{symbol}")
def get_tick(symbol: str):

    connected = MT5Client.connect()

    if not connected:
        return {
            "success": False,
            "message": "MT5 not connected"
        }

    tick = MT5Client.get_symbol_tick(symbol)

    if tick is None:
        return {
            "success": False,
            "message": f"Symbol {symbol} not found"
        }

    return {
        "success": True,
        "symbol": symbol,
        "data": tick
    }


@router.get("/candles/{symbol}/{timeframe}")
def get_candles(
    symbol: str,
    timeframe: str,
    count: int = 100
):

    connected = MT5Client.connect()

    if not connected:
        return {
            "success": False,
            "message": "MT5 not connected"
        }

    tf = TIMEFRAMES.get(timeframe)

    if tf is None:
        return {
            "success": False,
            "message": "Invalid timeframe"
        }

    candles = MT5Client.get_rates(
        symbol,
        tf,
        count
    )

    return {
        "success": True,
        "symbol": symbol,
        "timeframe": timeframe,
        "count": count,
        "data": candles
    }


@router.get("/candles/{symbol}/{timeframe}/range")
def get_candles_range(symbol: str, timeframe: str, from_date: str, to_date: str):
    connected = MT5Client.connect()
    if not connected:
        return {"success": False, "message": "MT5 not connected"}

    tf = TIMEFRAMES.get(timeframe)
    if tf is None:
        return {"success": False, "message": "Invalid timeframe"}

    try:
        from_dt = datetime.fromisoformat(from_date)
        to_dt = datetime.fromisoformat(to_date)
    except ValueError:
        return {"success": False, "message": "Invalid date format — use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS"}

    candles = MT5Client.get_rates_range(symbol, tf, from_dt, to_dt)
    if candles is None:
        return {"success": False, "message": f"No data for {symbol}/{timeframe} in the requested range"}

    return {
        "success": True,
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(candles),
        "data": candles,
    }


@router.patch("/positions/{ticket}")
def modify_position(ticket: int, body: dict):

    connected = MT5Client.connect()

    if not connected:
        return {
            "success": False,
            "message": "MT5 not connected"
        }

    result = MT5Client.modify_position(
        ticket=ticket,
        sl=body["sl"],
        tp=body["tp"],
        symbol=body["symbol"],
    )

    return result


class PartialCloseBody(BaseModel):
    volume: float
    symbol: str


@router.post("/positions/{ticket}/partial-close")
def partial_close_position(ticket: int, body: PartialCloseBody):
    connected = MT5Client.connect()
    if not connected:
        return {"success": False, "message": "MT5 not connected"}
    return MT5Client.partial_close_position(ticket, body.volume, body.symbol)


class ClosePositionBody(BaseModel):
    symbol: str


@router.post("/positions/{ticket}/close")
def close_position(ticket: int, body: ClosePositionBody):
    connected = MT5Client.connect()
    if not connected:
        return {"success": False, "message": "MT5 not connected"}
    return MT5Client.close_position(ticket, body.symbol)


@router.get("/history/{ticket}")
def get_position_history(ticket: int):

    connected = MT5Client.connect()

    if not connected:
        return {"success": False, "message": "MT5 not connected"}

    history = MT5Client.get_position_history(ticket)

    if history is None:
        return {"success": False, "message": f"No history found for ticket {ticket}"}

    return {"success": True, "data": history}


@router.post("/trade")
def place_trade(order: dict):

    try:

        connected = MT5Client.connect()

        if not connected:
            return {
                "success": False,
                "message": "MT5 not connected"
            }

        print("ORDER RECEIVED:", order)

        result = MT5Client.place_order(
            symbol=order["symbol"],
            order_type=order["side"],
            volume=order["volume"],
            stop_loss=order["stopLoss"],
            take_profit=order["takeProfit"]
        )

        print("RESULT:", result)

        return result

    except Exception as e:

        print("ERROR:", str(e))

        return {
            "success": False,
            "message": str(e)
        }
    

    
    connected = MT5Client.connect()

    if not connected:
        return {
            "success": False,
            "message": "MT5 not connected"
        }

    result = MT5Client.place_order(
        symbol=order["symbol"],
        order_type=order["side"],
        volume=order["volume"],
        stop_loss=order["stopLoss"],
        take_profit=order["takeProfit"]
    )

    return result