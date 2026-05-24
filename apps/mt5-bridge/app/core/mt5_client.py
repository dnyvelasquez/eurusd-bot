import MetaTrader5 as mt5

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1
}


class MT5Client:

    @staticmethod
    def connect():

        if mt5.initialize():
            return True

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

        return {
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
            "comment": "SPX500 BOT",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_FOK
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