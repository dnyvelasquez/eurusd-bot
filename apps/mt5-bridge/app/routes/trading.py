from fastapi import APIRouter
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