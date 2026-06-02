import json
from datetime import datetime, timedelta
from pathlib import Path

import MetaTrader5 as mt5

_CONFIG_PATH = (Path(__file__).parent / ".." / ".." / ".." / ".." / "config.json").resolve()


def _read_terminal_path() -> str:
    try:
        cfg = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        return cfg.get("MT5_TERMINAL_PATH", "").strip()
    except Exception:
        return ""

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


class MT5Client:

    @staticmethod
    def _get_filling_mode(symbol: str):
        info = mt5.symbol_info(symbol)
        if info is None:
            return mt5.ORDER_FILLING_IOC
        filling = info.filling_mode
        if filling & 1:
            return mt5.ORDER_FILLING_FOK
        if filling & 2:
            return mt5.ORDER_FILLING_IOC
        return mt5.ORDER_FILLING_RETURN

    @staticmethod
    def get_symbol_info(symbol: str):
        info = mt5.symbol_info(symbol)
        if info is None:
            return None
        return {
            "point": float(info.point),
            "tradeTickSize": float(info.trade_tick_size),
            "tradeTickValue": float(info.trade_tick_value),
            "tradeContractSize": float(info.trade_contract_size),
        }

    @staticmethod
    def connect():
        path = _read_terminal_path()
        try:
            if path:
                return bool(mt5.initialize(path=path))
            return bool(mt5.initialize())
        except Exception:
            return False

    @staticmethod
    def shutdown():
        mt5.shutdown()

    @staticmethod
    def get_symbol_tick(symbol: str):

        tick = mt5.symbol_info_tick(symbol)

        if tick is None:
            return None

        return {
            "bid": tick.bid,
            "ask": tick.ask,
            "last": tick.last,
            "time": tick.time
        }

    @staticmethod
    def get_rates_range(symbol: str, timeframe, from_dt, to_dt):
        rates = mt5.copy_rates_range(symbol, timeframe, from_dt, to_dt)
        if rates is None:
            return None
        return [
            {
                "time": int(r["time"]),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "tick_volume": int(r["tick_volume"]),
            }
            for r in rates
        ]

    @staticmethod
    def get_rates(symbol: str, timeframe, count: int):

        rates = mt5.copy_rates_from_pos(
            symbol,
            timeframe,
            0,
            count
        )

        if rates is None:
            return None

        candles = []

        for rate in rates:

            candles.append({
                "time": int(rate["time"]),
                "open": float(rate["open"]),
                "high": float(rate["high"]),
                "low": float(rate["low"]),
                "close": float(rate["close"]),
                "tick_volume": int(rate["tick_volume"])
            })

        return candles

    @staticmethod
    def get_account_info():

        info = mt5.account_info()

        if info is None:
            return None

        trade_mode_map = {0: "DEMO", 1: "CONTEST", 2: "REAL"}

        return {
            "login": int(info.login),
            "tradeMode": trade_mode_map.get(info.trade_mode, "DEMO"),
            "balance": float(info.balance),
            "equity": float(info.equity),
            "margin": float(info.margin),
            "freeMargin": float(info.margin_free),
        }

    @staticmethod
    def get_positions(symbol: str):

        positions = mt5.positions_get(symbol=symbol)

        if positions is None:
            return []

        return [
            {
                "ticket": int(p.ticket),
                "symbol": p.symbol,
                "type": "BUY" if p.type == 0 else "SELL",
                "volume": float(p.volume),
                "priceOpen": float(p.price_open),
                "stopLoss": float(p.sl),
                "takeProfit": float(p.tp),
                "profit": float(p.profit),
            }
            for p in positions
        ]

    @staticmethod
    def modify_position(ticket: int, sl: float, tp: float, symbol: str):

        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": symbol,
            "sl": sl,
            "tp": tp,
        }

        result = mt5.order_send(request)

        if result is None:
            return {"success": False, "message": "Modify failed"}

        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {
                "success": False,
                "message": f"MT5 Error: {result.retcode}",
                "retcode": result.retcode,
            }

        return {"success": True}

    @staticmethod
    def get_position_history(ticket: int):
        from_date = datetime(2020, 1, 1)
        to_date = datetime.now() + timedelta(days=1)

        deals = mt5.history_deals_get(from_date, to_date, position=ticket)

        if deals is None or len(deals) == 0:
            return None

        # DEAL_ENTRY_OUT = 1 (closing deal)
        closing = [d for d in deals if d.entry == 1]

        if not closing:
            return None

        deal = closing[-1]
        return {
            "ticket": ticket,
            "closePrice": float(deal.price),
            "profit": float(deal.profit),
        }

    @staticmethod
    def partial_close_position(ticket: int, volume: float, symbol: str):
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return {"success": False, "message": f"No open positions for {symbol}"}

        pos = next((p for p in positions if p.ticket == ticket), None)
        if pos is None:
            return {"success": False, "message": f"Position {ticket} not found"}

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return {"success": False, "message": "Symbol tick not found"}

        if pos.type == mt5.ORDER_TYPE_BUY:
            close_type = mt5.ORDER_TYPE_SELL
            price = tick.bid
        else:
            close_type = mt5.ORDER_TYPE_BUY
            price = tick.ask

        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(volume),
            "type": close_type,
            "position": ticket,
            "price": float(price),
            "deviation": 20,
            "magic": 777,
            "comment": "EURUSD BOT partial TP",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": MT5Client._get_filling_mode(symbol),
        }

        result = mt5.order_send(request)
        if result is None:
            return {"success": False, "message": "Partial close failed"}
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {"success": False, "message": f"MT5 Error: {result.retcode}", "retcode": result.retcode}

        return {"success": True}

    @staticmethod
    def close_position(ticket: int, symbol: str):
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return {"success": False, "message": f"No open positions for {symbol}"}

        pos = next((p for p in positions if p.ticket == ticket), None)
        if pos is None:
            return {"success": False, "message": f"Position {ticket} not found"}

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return {"success": False, "message": "Symbol tick not found"}

        close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
        price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask

        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(pos.volume),
            "type": close_type,
            "position": ticket,
            "price": float(price),
            "deviation": 20,
            "magic": 777,
            "comment": "EURUSD BOT EOD close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": MT5Client._get_filling_mode(symbol),
        }

        result = mt5.order_send(request)
        if result is None:
            return {"success": False, "message": "Close failed"}
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {"success": False, "message": f"MT5 Error: {result.retcode}", "retcode": result.retcode}

        return {"success": True}

    @staticmethod
    def place_order(
        symbol: str,
        order_type: str,
        volume: float,
        stop_loss: float,
        take_profit: float
    ):

        tick = mt5.symbol_info_tick(symbol)

        if tick is None:
            return {
                "success": False,
                "message": "Symbol tick not found"
            }

        if order_type == "BUY":
            price = tick.ask
            mt5_type = mt5.ORDER_TYPE_BUY

        else:
            price = tick.bid
            mt5_type = mt5.ORDER_TYPE_SELL


        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(volume),
            "type": mt5_type,
            "price": float(price),
            "sl": float(stop_loss),
            "tp": float(take_profit),
            "deviation": 20,
            "magic": 777,
            "comment": "EURUSD BOT",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": MT5Client._get_filling_mode(symbol)
        }

        result = mt5.order_send(request)
        
        print(result)

        if result is None:
            return {
                "success": False,
                "message": "Order send failed"
            }

        if result.retcode != mt5.TRADE_RETCODE_DONE:

            return {
                "success": False,
                "message": f"MT5 Error: {result.retcode}",
                "retcode": result.retcode,
                "comment": result.comment
            }
        return {
            "success": True,
            "orderId": result.order or result.deal
        }