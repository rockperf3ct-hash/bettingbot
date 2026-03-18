"""
Live Bet Tracker — SQLite-backed real bet log.

Schema:
  bets(id, created_at, date, league, sport, home_team, away_team,
       bet_side, bet_team, bet_type, stake, odds, model_prob, edge,
       result, pnl, notes)

  parlays(id, created_at, date, stake, combined_odds, result, pnl, notes)
  parlay_legs(id, parlay_id, league, sport, home_team, away_team,
              bet_side, bet_team, bet_type, odds, result)

result: NULL = pending, 'won', 'lost', 'void'
bet_type: 'moneyline', 'spread', 'total_over', 'total_under', 'draw'
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path("data/tracker.db")


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def _db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT    NOT NULL,
                date        TEXT    NOT NULL,
                league      TEXT    NOT NULL DEFAULT '',
                sport       TEXT    NOT NULL DEFAULT '',
                home_team   TEXT    NOT NULL DEFAULT '',
                away_team   TEXT    NOT NULL DEFAULT '',
                bet_side    TEXT    NOT NULL DEFAULT '',
                bet_team    TEXT    NOT NULL DEFAULT '',
                bet_type    TEXT    NOT NULL DEFAULT 'moneyline',
                stake       REAL    NOT NULL,
                odds        REAL    NOT NULL,
                model_prob  REAL,
                edge        REAL,
                result      TEXT,
                pnl         REAL,
                notes       TEXT    DEFAULT ''
            )
        """)
        # Safe migration: add bet_type column if it doesn't exist yet
        try:
            conn.execute("ALTER TABLE bets ADD COLUMN bet_type TEXT NOT NULL DEFAULT 'moneyline'")
        except sqlite3.OperationalError:
            pass  # column already exists

        conn.execute("""
            CREATE TABLE IF NOT EXISTS parlays (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at    TEXT    NOT NULL,
                date          TEXT    NOT NULL,
                stake         REAL    NOT NULL,
                combined_odds REAL    NOT NULL,
                result        TEXT,
                pnl           REAL,
                notes         TEXT    DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS parlay_legs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                parlay_id  INTEGER NOT NULL REFERENCES parlays(id) ON DELETE CASCADE,
                league     TEXT    NOT NULL DEFAULT '',
                sport      TEXT    NOT NULL DEFAULT '',
                home_team  TEXT    NOT NULL DEFAULT '',
                away_team  TEXT    NOT NULL DEFAULT '',
                bet_side   TEXT    NOT NULL DEFAULT '',
                bet_team   TEXT    NOT NULL DEFAULT '',
                bet_type   TEXT    NOT NULL DEFAULT 'moneyline',
                odds       REAL    NOT NULL,
                result     TEXT
            )
        """)
        conn.execute("PRAGMA foreign_keys = ON")


# ---------------------------------------------------------------------------
# Straight bets
# ---------------------------------------------------------------------------

def add_bet(
    date: str,
    league: str,
    sport: str,
    home_team: str,
    away_team: str,
    bet_side: str,
    bet_team: str,
    stake: float,
    odds: float,
    bet_type: str = "moneyline",
    model_prob: float | None = None,
    edge: float | None = None,
    notes: str = "",
) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with _db() as conn:
        cur = conn.execute("""
            INSERT INTO bets
              (created_at, date, league, sport, home_team, away_team,
               bet_side, bet_team, bet_type, stake, odds, model_prob, edge, result, pnl, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)
        """, (now, date, league, sport, home_team, away_team,
              bet_side, bet_team, bet_type, stake, odds, model_prob, edge, notes))
        row = conn.execute("SELECT * FROM bets WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict(row)


def settle_bet(bet_id: int, result: str) -> dict:
    """result: 'won' | 'lost' | 'void'"""
    with _db() as conn:
        row = conn.execute("SELECT stake, odds FROM bets WHERE id=?", (bet_id,)).fetchone()
        if not row:
            raise ValueError(f"Bet {bet_id} not found")
        stake, odds = row["stake"], row["odds"]
        if result == "won":
            pnl = stake * (odds - 1)
        elif result == "lost":
            pnl = -stake
        else:
            pnl = 0.0
        conn.execute("UPDATE bets SET result=?, pnl=? WHERE id=?", (result, pnl, bet_id))
        updated = conn.execute("SELECT * FROM bets WHERE id=?", (bet_id,)).fetchone()
        return dict(updated)


def delete_bet(bet_id: int) -> bool:
    with _db() as conn:
        cur = conn.execute("DELETE FROM bets WHERE id=?", (bet_id,))
        return cur.rowcount > 0


def get_bet(bet_id: int) -> dict:
    with _db() as conn:
        row = conn.execute("SELECT * FROM bets WHERE id=?", (bet_id,)).fetchone()
        if not row:
            raise ValueError(f"Bet {bet_id} not found")
        return dict(row)


def list_bets(
    limit: int = 200,
    offset: int = 0,
    sport: str | None = None,
    result: str | None = None,
) -> list[dict]:
    where, params = [], []
    if sport:
        where.append("sport=?"); params.append(sport)
    if result:
        where.append("result=?"); params.append(result)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with _db() as conn:
        rows = conn.execute(
            f"SELECT * FROM bets {clause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset)
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Parlays
# ---------------------------------------------------------------------------

def add_parlay(
    date: str,
    stake: float,
    legs: list[dict],
    notes: str = "",
) -> dict:
    """
    Create a parlay with multiple legs.

    legs: list of dicts with keys:
        league, sport, home_team, away_team, bet_side, bet_team, bet_type, odds
    """
    if len(legs) < 2:
        raise ValueError("A parlay requires at least 2 legs")

    # Combined odds = product of all leg decimal odds
    combined_odds = 1.0
    for leg in legs:
        combined_odds *= float(leg["odds"])
    combined_odds = round(combined_odds, 4)

    now = datetime.now(timezone.utc).isoformat()
    with _db() as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.execute("""
            INSERT INTO parlays (created_at, date, stake, combined_odds, result, pnl, notes)
            VALUES (?,?,?,?,NULL,NULL,?)
        """, (now, date, stake, combined_odds, notes))
        parlay_id = cur.lastrowid

        for leg in legs:
            conn.execute("""
                INSERT INTO parlay_legs
                  (parlay_id, league, sport, home_team, away_team,
                   bet_side, bet_team, bet_type, odds, result)
                VALUES (?,?,?,?,?,?,?,?,?,NULL)
            """, (
                parlay_id,
                leg.get("league", ""),
                leg.get("sport", ""),
                leg.get("home_team", ""),
                leg.get("away_team", ""),
                leg.get("bet_side", ""),
                leg.get("bet_team", ""),
                leg.get("bet_type", "moneyline"),
                float(leg["odds"]),
            ))

        parlay = conn.execute("SELECT * FROM parlays WHERE id=?", (parlay_id,)).fetchone()
        leg_rows = conn.execute(
            "SELECT * FROM parlay_legs WHERE parlay_id=? ORDER BY id", (parlay_id,)
        ).fetchall()

    result = dict(parlay)
    result["legs"] = [dict(r) for r in leg_rows]
    return result


def settle_parlay(parlay_id: int, result: str) -> dict:
    """
    Settle an entire parlay manually.
    result: 'won' | 'lost' | 'void'
    """
    with _db() as conn:
        row = conn.execute(
            "SELECT stake, combined_odds FROM parlays WHERE id=?", (parlay_id,)
        ).fetchone()
        if not row:
            raise ValueError(f"Parlay {parlay_id} not found")
        stake, combined_odds = row["stake"], row["combined_odds"]
        if result == "won":
            pnl = stake * (combined_odds - 1)
        elif result == "lost":
            pnl = -stake
        else:
            pnl = 0.0
        conn.execute(
            "UPDATE parlays SET result=?, pnl=? WHERE id=?", (result, pnl, parlay_id)
        )
        # Mark all legs won/lost/void together
        conn.execute(
            "UPDATE parlay_legs SET result=? WHERE parlay_id=?", (result, parlay_id)
        )
        parlay = conn.execute("SELECT * FROM parlays WHERE id=?", (parlay_id,)).fetchone()
        legs = conn.execute(
            "SELECT * FROM parlay_legs WHERE parlay_id=? ORDER BY id", (parlay_id,)
        ).fetchall()

    result_dict = dict(parlay)
    result_dict["legs"] = [dict(r) for r in legs]
    return result_dict


def settle_parlay_auto(parlay_id: int, leg_results: dict[int, str]) -> dict:
    """
    Auto-settle a parlay from individual leg results.
    leg_results: {leg_id: 'won' | 'lost' | 'void'}
    If any leg is 'lost' → parlay is lost.
    If all legs are 'won' → parlay is won.
    Any 'void' leg is treated as a push (leg removed from parlay effectively).
    """
    with _db() as conn:
        row = conn.execute(
            "SELECT stake, combined_odds FROM parlays WHERE id=?", (parlay_id,)
        ).fetchone()
        if not row:
            raise ValueError(f"Parlay {parlay_id} not found")
        stake = row["stake"]

        # Update individual leg results and recalculate combined odds excluding voids
        active_odds = 1.0
        parlay_result = "won"
        for leg_id, leg_result in leg_results.items():
            conn.execute(
                "UPDATE parlay_legs SET result=? WHERE id=? AND parlay_id=?",
                (leg_result, leg_id, parlay_id),
            )
            leg = conn.execute(
                "SELECT odds FROM parlay_legs WHERE id=?", (leg_id,)
            ).fetchone()
            if leg:
                if leg_result == "lost":
                    parlay_result = "lost"
                elif leg_result == "won":
                    active_odds *= leg["odds"]
                # void legs: excluded from odds product

        if parlay_result == "won":
            pnl = stake * (active_odds - 1)
            combined_odds = round(active_odds, 4)
        else:
            pnl = -stake
            combined_odds = row["combined_odds"]

        conn.execute(
            "UPDATE parlays SET result=?, pnl=?, combined_odds=? WHERE id=?",
            (parlay_result, pnl, combined_odds, parlay_id),
        )
        parlay = conn.execute("SELECT * FROM parlays WHERE id=?", (parlay_id,)).fetchone()
        legs = conn.execute(
            "SELECT * FROM parlay_legs WHERE parlay_id=? ORDER BY id", (parlay_id,)
        ).fetchall()

    result_dict = dict(parlay)
    result_dict["legs"] = [dict(r) for r in legs]
    return result_dict


def delete_parlay(parlay_id: int) -> bool:
    with _db() as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.execute("DELETE FROM parlays WHERE id=?", (parlay_id,))
        return cur.rowcount > 0


def list_parlays(
    limit: int = 100,
    offset: int = 0,
    result: str | None = None,
) -> list[dict]:
    where, params = [], []
    if result:
        where.append("p.result=?"); params.append(result)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with _db() as conn:
        parlays = conn.execute(
            f"SELECT * FROM parlays {clause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        result_list = []
        for p in parlays:
            legs = conn.execute(
                "SELECT * FROM parlay_legs WHERE parlay_id=? ORDER BY id", (p["id"],)
            ).fetchall()
            d = dict(p)
            d["legs"] = [dict(r) for r in legs]
            result_list.append(d)
    return result_list


def get_parlay(parlay_id: int) -> dict:
    with _db() as conn:
        p = conn.execute("SELECT * FROM parlays WHERE id=?", (parlay_id,)).fetchone()
        if not p:
            raise ValueError(f"Parlay {parlay_id} not found")
        legs = conn.execute(
            "SELECT * FROM parlay_legs WHERE parlay_id=? ORDER BY id", (parlay_id,)
        ).fetchall()
    d = dict(p)
    d["legs"] = [dict(r) for r in legs]
    return d


# ---------------------------------------------------------------------------
# Auto-resolve parlays from ESPN scores
# ---------------------------------------------------------------------------

def auto_resolve_parlays(target_date: str) -> dict:
    """
    For all pending parlays on target_date, fetch ESPN/MLB scores and
    resolve each leg automatically, then settle the parlay.

    Returns a summary dict.
    """
    from sports_model.espn_ingest import fetch_espn_all_leagues, fetch_mlb_scoreboard
    import pandas as pd
    from datetime import date as _date

    # Fetch scores for target_date (not just today)
    try:
        game_date = _date.fromisoformat(target_date) if target_date else _date.today()
        espn_df = fetch_espn_all_leagues(game_date=game_date)
        mlb_rows = fetch_mlb_scoreboard(game_date=game_date)
        mlb_df = pd.DataFrame(mlb_rows)
        if not mlb_df.empty:
            mlb_df["date"] = pd.to_datetime(mlb_df["date"], utc=True)
        frames = [f for f in [espn_df, mlb_df] if not f.empty]
        df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        if df.empty:
            return {"resolved": 0, "skipped": 0, "detail": "No scoreboard data"}
    except Exception as exc:
        return {"resolved": 0, "skipped": 0, "detail": str(exc)}

    # Build a lookup: (home_norm, away_norm) -> {home_score, away_score, status}
    score_lookup: dict[tuple[str, str], dict] = {}
    for _, row in df.iterrows():
        status = str(row.get("status", ""))
        if "FINAL" not in status.upper() and "FULL_TIME" not in status.upper():
            continue
        h = str(row.get("home_team", "")).lower().strip()
        a = str(row.get("away_team", "")).lower().strip()
        score_lookup[(h, a)] = {
            "home_score": row.get("home_score"),
            "away_score": row.get("away_score"),
        }

    with _db() as conn:
        pending_parlays = conn.execute(
            "SELECT * FROM parlays WHERE result IS NULL AND date=?", (target_date,)
        ).fetchall()

    resolved_count = 0
    skipped_count = 0

    for p in pending_parlays:
        with _db() as conn:
            legs = conn.execute(
                "SELECT * FROM parlay_legs WHERE parlay_id=? AND result IS NULL ORDER BY id",
                (p["id"],),
            ).fetchall()

        if not legs:
            continue

        leg_results: dict[int, str] = {}
        all_found = True

        for leg in legs:
            h = str(leg["home_team"]).lower().strip()
            a = str(leg["away_team"]).lower().strip()
            scores = score_lookup.get((h, a)) or score_lookup.get((a, h))

            if not scores:
                all_found = False
                continue

            hs = scores["home_score"]
            as_ = scores["away_score"]
            if hs is None or as_ is None:
                all_found = False
                continue

            side = leg["bet_side"]
            bet_type = leg.get("bet_type", "moneyline")

            if bet_type in ("moneyline", "draw"):
                if side == "home":
                    leg_result = "won" if hs > as_ else "lost"
                elif side == "away":
                    leg_result = "won" if as_ > hs else "lost"
                else:  # draw
                    leg_result = "won" if hs == as_ else "lost"
            elif bet_type == "total_over":
                # Stored in notes as "over X.X" — fall back to manual
                all_found = False
                continue
            elif bet_type == "total_under":
                all_found = False
                continue
            else:
                all_found = False
                continue

            leg_results[leg["id"]] = leg_result

        if all_found and leg_results:
            settle_parlay_auto(p["id"], leg_results)
            resolved_count += 1
        else:
            skipped_count += 1

    return {
        "resolved": resolved_count,
        "skipped": skipped_count,
        "date": target_date,
    }


# ---------------------------------------------------------------------------
# Summary + equity (includes parlays)
# ---------------------------------------------------------------------------

def tracker_summary() -> dict:
    with _db() as conn:
        # Straight bets
        total = conn.execute("SELECT COUNT(*) FROM bets").fetchone()[0]
        settled = conn.execute(
            "SELECT COUNT(*) FROM bets WHERE result IS NOT NULL AND result != 'void'"
        ).fetchone()[0]
        won = conn.execute("SELECT COUNT(*) FROM bets WHERE result='won'").fetchone()[0]
        total_staked = conn.execute(
            "SELECT COALESCE(SUM(stake),0) FROM bets WHERE result IS NOT NULL"
        ).fetchone()[0]
        total_pnl = conn.execute(
            "SELECT COALESCE(SUM(pnl),0) FROM bets WHERE pnl IS NOT NULL"
        ).fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) FROM bets WHERE result IS NULL").fetchone()[0]

        # Parlays
        p_total = conn.execute("SELECT COUNT(*) FROM parlays").fetchone()[0]
        p_settled = conn.execute(
            "SELECT COUNT(*) FROM parlays WHERE result IS NOT NULL AND result != 'void'"
        ).fetchone()[0]
        p_won = conn.execute("SELECT COUNT(*) FROM parlays WHERE result='won'").fetchone()[0]
        p_staked = conn.execute(
            "SELECT COALESCE(SUM(stake),0) FROM parlays WHERE result IS NOT NULL"
        ).fetchone()[0]
        p_pnl = conn.execute(
            "SELECT COALESCE(SUM(pnl),0) FROM parlays WHERE pnl IS NOT NULL"
        ).fetchone()[0]
        p_pending = conn.execute("SELECT COUNT(*) FROM parlays WHERE result IS NULL").fetchone()[0]

    all_settled = settled + p_settled
    all_won = won + p_won
    all_staked = total_staked + p_staked
    all_pnl = total_pnl + p_pnl

    return {
        "total_bets":       total,
        "pending":          pending + p_pending,
        "settled":          all_settled,
        "won":              all_won,
        "lost":             all_settled - all_won,
        "hit_rate":         (all_won / all_settled) if all_settled > 0 else None,
        "total_staked":     all_staked,
        "total_pnl":        all_pnl,
        "roi":              (all_pnl / all_staked) if all_staked > 0 else None,
        # Broken down
        "straight_bets":    total,
        "parlays":          p_total,
        "parlay_pending":   p_pending,
        "parlay_won":       p_won,
    }


def equity_curve() -> list[dict]:
    """Running P&L from both straight bets and parlays, sorted by date."""
    with _db() as conn:
        straight = conn.execute(
            "SELECT date, pnl, 'straight' as type FROM bets WHERE pnl IS NOT NULL"
        ).fetchall()
        parlays = conn.execute(
            "SELECT date, pnl, 'parlay' as type FROM parlays WHERE pnl IS NOT NULL"
        ).fetchall()

    all_rows = sorted(
        [dict(r) for r in straight] + [dict(r) for r in parlays],
        key=lambda r: (r["date"], r["type"]),
    )

    running = 0.0
    points = []
    for r in all_rows:
        running += r["pnl"]
        points.append({
            "date": r["date"],
            "pnl": r["pnl"],
            "type": r["type"],
            "running_pnl": round(running, 2),
        })
    return points


# Initialise DB on import
init_db()
