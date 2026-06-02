import os

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException

router = APIRouter()


def _get_conn():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=503, detail="DATABASE_URL not configured")
    return psycopg2.connect(db_url, cursor_factory=psycopg2.extras.RealDictCursor)


@router.get("/trades")
def get_trades(limit: int = 50):
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, ticket, symbol, side, volume, entry_price, stop_loss, take_profit,
                       planned_rr, risk_amount, opened_at, closed_at, close_price, profit, actual_rr, result
                FROM trades
                ORDER BY opened_at DESC
                LIMIT %s
                """,
                (min(limit, 200),),
            )
            rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return {"success": True, "data": rows}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/stats")
def get_stats():
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*)    FILTER (WHERE closed_at IS NOT NULL)                           AS total_closed,
                    COUNT(*)    FILTER (WHERE result = 'WIN')                                  AS wins,
                    COUNT(*)    FILTER (WHERE result = 'LOSS')                                 AS losses,
                    COUNT(*)    FILTER (WHERE result = 'BE')                                   AS breakevens,
                    COUNT(*)    FILTER (WHERE closed_at IS NULL)                               AS open_trades,
                    ROUND(AVG(actual_rr)  FILTER (WHERE closed_at IS NOT NULL)::numeric, 2)   AS avg_rr,
                    ROUND(SUM(profit)     FILTER (WHERE closed_at IS NOT NULL)::numeric, 2)   AS total_pnl,
                    COALESCE(SUM(profit)  FILTER (WHERE profit > 0 AND closed_at IS NOT NULL), 0) AS gross_profit,
                    COALESCE(ABS(SUM(profit) FILTER (WHERE profit < 0 AND closed_at IS NOT NULL)), 0) AS gross_loss
                FROM trades
                """
            )
            row = dict(cur.fetchone())

            total      = row["total_closed"] or 0
            wins       = row["wins"] or 0
            win_rate   = round(wins / total * 100, 1) if total > 0 else 0
            gross_p    = float(row["gross_profit"])
            gross_l    = float(row["gross_loss"])
            pf         = round(gross_p / gross_l, 2) if gross_l > 0 else None

            # Loss streak calculation — must run inside the same cursor context
            cur.execute(
                "SELECT result FROM trades WHERE closed_at IS NOT NULL ORDER BY closed_at ASC"
            )
            results = [r["result"] for r in cur.fetchall()]

        conn.close()

        max_loss_streak = 0
        cur_streak = 0
        for r in results:
            if r == "LOSS":
                cur_streak += 1
                max_loss_streak = max(max_loss_streak, cur_streak)
            else:
                cur_streak = 0

        return {
            "success": True,
            "data": {
                "total_closed":       total,
                "wins":               wins,
                "losses":             row["losses"] or 0,
                "breakevens":         row["breakevens"] or 0,
                "open_trades":        row["open_trades"] or 0,
                "win_rate":           win_rate,
                "avg_rr":             float(row["avg_rr"]) if row["avg_rr"] is not None else None,
                "total_pnl":          float(row["total_pnl"]) if row["total_pnl"] is not None else 0.0,
                "profit_factor":      pf,
                "max_loss_streak":    max_loss_streak,
                "current_loss_streak": cur_streak,
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/trades")
def reset_trades():
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE trades RESTART IDENTITY")
        conn.commit()
        conn.close()
        return {"success": True, "message": "Journal cleared"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
