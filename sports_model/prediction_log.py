"""
Prediction Log — stores every AI pick and auto-resolves outcomes from ESPN.

Schema (predictions table):
  id, created_at, pick_date, resolved_at,
  sport, league, home_team, away_team,
  bet_side, bet_team, model_prob, implied_prob, edge, odds, tier,
  home_score, away_score, result ('won'|'lost'|'push'|'pending'),
  correct (1|0|NULL)

Auto-resolution logic:
  - Fetch ESPN/MLB scoreboard for pick_date
  - Match game by home_team + away_team (fuzzy if needed)
  - If home_score > away_score → home wins; < → away wins; = → push
  - Compare with bet_side to set result + correct flag
"""
from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

def _default_db_path() -> Path:
    base = os.getenv("DATA_DIR")
    if not base:
        base = "/tmp/data" if (os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME")) else "data"
    return Path(base) / "tracker.db"


DB_PATH = _default_db_path()


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


# ---------------------------------------------------------------------------
# Schema init
# ---------------------------------------------------------------------------

def init_predictions_table() -> None:
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS predictions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT NOT NULL,
                pick_date   TEXT NOT NULL,
                resolved_at TEXT,
                sport       TEXT NOT NULL DEFAULT '',
                league      TEXT NOT NULL DEFAULT '',
                home_team   TEXT NOT NULL DEFAULT '',
                away_team   TEXT NOT NULL DEFAULT '',
                bet_side    TEXT NOT NULL DEFAULT '',
                bet_team    TEXT NOT NULL DEFAULT '',
                model_prob  REAL,
                implied_prob REAL,
                edge        REAL,
                odds        REAL,
                tier        TEXT,
                total_line  REAL,
                market      TEXT DEFAULT 'h2h',
                home_score  REAL,
                away_score  REAL,
                result      TEXT DEFAULT 'pending',
                correct     INTEGER
            )
        """)
        # Migrate: add columns if they don't exist yet (safe on existing DBs)
        for col, typedef in [("total_line", "REAL"), ("market", "TEXT DEFAULT 'h2h'")]:
            try:
                conn.execute(f"ALTER TABLE predictions ADD COLUMN {col} {typedef}")
            except Exception:
                pass  # column already exists
        # Index for fast date lookups
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_pred_date ON predictions(pick_date)
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_pred_game
            ON predictions(pick_date, home_team, away_team, bet_side)
        """)


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

def log_picks(picks: list[dict], pick_date: str | None = None) -> int:
    """
    Persist a list of pick dicts (from build_recommendations / score_todays_games).
    Skips duplicates (same date + matchup + side).
    Returns count of newly inserted rows.
    """
    if not picks:
        return 0
    today = pick_date or date.today().isoformat()
    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with _db() as conn:
        for p in picks:
            try:
                conn.execute("""
                    INSERT OR IGNORE INTO predictions
                      (created_at, pick_date, sport, league, home_team, away_team,
                       bet_side, bet_team, model_prob, implied_prob, edge, odds, tier,
                       total_line, market, result, correct)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL)
                """, (
                    now, today,
                    p.get("sport", ""),
                    p.get("league", ""),
                    p.get("home_team", ""),
                    p.get("away_team", ""),
                    p.get("bet_side", ""),
                    p.get("bet_team", ""),
                    p.get("model_prob"),
                    p.get("implied_prob"),
                    p.get("edge"),
                    p.get("odds"),
                    p.get("tier"),
                    p.get("total_line"),
                    p.get("market", "h2h"),
                ))
                if conn.execute("SELECT changes()").fetchone()[0]:
                    inserted += 1
            except Exception as exc:
                logger.warning("Failed to log pick %s: %s", p.get("game_id"), exc)
    logger.info("Logged %d new predictions for %s", inserted, today)
    return inserted


# ---------------------------------------------------------------------------
# Auto-resolver
# ---------------------------------------------------------------------------

def _normalize(name: str) -> str:
    """Lowercase, strip common suffixes for fuzzy matching."""
    import re
    name = name.lower().strip()
    for suffix in [" fc", " cf", " sc", " ac", " united", " city", " utd"]:
        name = name.replace(suffix, "")
    name = re.sub(r"[^a-z0-9 ]", "", name)
    return name.strip()


def _match_game(pred_home: str, pred_away: str, results: list[dict]) -> dict | None:
    """Find the result row that matches a prediction's teams."""
    # Exact match first
    for r in results:
        if r.get("home_team") == pred_home and r.get("away_team") == pred_away:
            return r
    # Fuzzy match
    ph = _normalize(pred_home)
    pa = _normalize(pred_away)
    for r in results:
        rh = _normalize(r.get("home_team", ""))
        ra = _normalize(r.get("away_team", ""))
        if ph in rh or rh in ph:
            if pa in ra or ra in pa:
                return r
    return None


def _determine_result(bet_side: str, home_score: float, away_score: float,
                       total_line: float | None = None) -> tuple[str, int]:
    """Return (result_str, correct_int) from scores and bet side."""
    # Totals (Over/Under) resolution
    if bet_side in ("over", "under"):
        if total_line is None:
            return "pending", 0  # can't resolve without line
        actual_total = home_score + away_score
        if actual_total == total_line:
            return "push", 0
        went_over = actual_total > total_line
        if bet_side == "over":
            return ("won", 1) if went_over else ("lost", 0)
        else:  # under
            return ("won", 1) if not went_over else ("lost", 0)
    # Moneyline resolution
    home_won = home_score > away_score
    is_draw  = home_score == away_score
    if bet_side == "draw":
        # Draw bet wins on a draw, loses otherwise — no push
        return ("won", 1) if is_draw else ("lost", 0)
    if is_draw:
        # Non-draw bet on a drawn game is a push
        return "push", 0
    if bet_side == "home":
        return ("won", 1) if home_won else ("lost", 0)
    else:  # away
        return ("won", 1) if not home_won else ("lost", 0)


def resolve_date(target_date: str | None = None) -> dict:
    """
    Fetch ESPN + MLB results for target_date (default: yesterday) and
    update all pending predictions for that date.

    Returns summary: {resolved, won, lost, push, not_found, date}
    """
    from sports_model.espn_ingest import ESPN_LEAGUES, fetch_espn_scoreboard, fetch_mlb_scoreboard

    if target_date is None:
        target_date = (date.today() - timedelta(days=1)).isoformat()

    game_date = date.fromisoformat(target_date)
    now = datetime.now(timezone.utc).isoformat()

    # Fetch all completed results for that date
    results: list[dict] = []
    for slug in ESPN_LEAGUES:
        try:
            rows = fetch_espn_scoreboard(slug, game_date=game_date)
            results.extend(rows)
        except Exception as exc:
            logger.warning("ESPN fetch failed %s %s: %s", slug, target_date, exc)
    try:
        results.extend(fetch_mlb_scoreboard(game_date=game_date))
    except Exception as exc:
        logger.warning("MLB fetch failed %s: %s", target_date, exc)

    # Filter to completed games only
    FINAL = {"STATUS_FINAL", "STATUS_FULL_TIME", "Final", "STATUS_FINAL_AET", "STATUS_FINAL_PEN", "Final/OT"}
    completed = [r for r in results if r.get("status") in FINAL]
    logger.info("Fetched %d completed games for %s", len(completed), target_date)

    # Load pending predictions for that date
    with _db() as conn:
        pending = conn.execute(
            "SELECT * FROM predictions WHERE pick_date=? AND result='pending'",
            (target_date,)
        ).fetchall()
        pending = [dict(r) for r in pending]

    summary = {"date": target_date, "resolved": 0, "won": 0, "lost": 0, "push": 0, "not_found": 0}

    for pred in pending:
        match = _match_game(pred["home_team"], pred["away_team"], completed)
        if match is None:
            logger.debug("No result found for %s vs %s", pred["home_team"], pred["away_team"])
            summary["not_found"] += 1
            continue

        hs = match.get("home_score")
        as_ = match.get("away_score")
        if hs is None or as_ is None:
            summary["not_found"] += 1
            continue

        result, correct = _determine_result(
            pred["bet_side"], float(hs), float(as_),
            total_line=pred.get("total_line"),
        )
        # If totals pick couldn't resolve (no total_line stored), skip
        if result == "pending":
            summary["not_found"] += 1
            continue
        summary[result] += 1
        summary["resolved"] += 1

        with _db() as conn:
            conn.execute("""
                UPDATE predictions
                SET result=?, correct=?, home_score=?, away_score=?, resolved_at=?
                WHERE id=?
            """, (result, correct, hs, as_, now, pred["id"]))

    logger.info("Resolved %s: %s", target_date, summary)
    return summary


# ---------------------------------------------------------------------------
# Read / Stats
# ---------------------------------------------------------------------------

def list_predictions(
    limit: int = 200,
    offset: int = 0,
    sport: str | None = None,
    tier: str | None = None,
    result: str | None = None,
) -> list[dict]:
    where, params = ["1=1"], []
    if sport:  where.append("sport=?");  params.append(sport)
    if tier:   where.append("tier=?");   params.append(tier)
    if result: where.append("result=?"); params.append(result)
    clause = " AND ".join(where)
    with _db() as conn:
        rows = conn.execute(
            f"SELECT * FROM predictions WHERE {clause} ORDER BY pick_date DESC, id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset)
        ).fetchall()
        return [dict(r) for r in rows]


def prediction_stats() -> dict:
    """Overall W/R stats broken down by sport and tier."""
    with _db() as conn:
        def _query(extra_where: str = "", params: tuple = ()) -> dict:
            base = f"WHERE result IS NOT NULL AND result != 'pending' {('AND ' + extra_where) if extra_where else ''}"
            total   = conn.execute(f"SELECT COUNT(*) FROM predictions {base}", params).fetchone()[0]
            won     = conn.execute(f"SELECT COUNT(*) FROM predictions {base} AND correct=1", params).fetchone()[0]
            lost    = conn.execute(f"SELECT COUNT(*) FROM predictions {base} AND correct=0", params).fetchone()[0]
            push    = conn.execute(f"SELECT COUNT(*) FROM predictions {base} AND result='push'", params).fetchone()[0]
            pending = conn.execute(f"SELECT COUNT(*) FROM predictions WHERE result='pending' {('AND ' + extra_where) if extra_where else ''}", params).fetchone()[0]
            avg_edge = conn.execute(f"SELECT AVG(edge) FROM predictions {base} AND edge IS NOT NULL", params).fetchone()[0]
            avg_prob = conn.execute(f"SELECT AVG(model_prob) FROM predictions {base} AND model_prob IS NOT NULL", params).fetchone()[0]
            return {
                "total": total, "won": won, "lost": lost, "push": push, "pending": pending,
                "hit_rate": round(won / total, 4) if total > 0 else None,
                "avg_edge": round(avg_edge, 4) if avg_edge else None,
                "avg_model_prob": round(avg_prob, 4) if avg_prob else None,
            }

        overall = _query()

        # By sport
        sports_raw = conn.execute(
            "SELECT DISTINCT sport FROM predictions WHERE result != 'pending'"
        ).fetchall()
        by_sport = {}
        for (sp,) in sports_raw:
            by_sport[sp] = _query("sport=?", (sp,))

        # By tier
        tiers_raw = conn.execute(
            "SELECT DISTINCT tier FROM predictions WHERE result != 'pending' AND tier IS NOT NULL"
        ).fetchall()
        by_tier = {}
        for (t,) in tiers_raw:
            by_tier[t] = _query("tier=?", (t,))

        return {"overall": overall, "by_sport": by_sport, "by_tier": by_tier}


def rolling_accuracy(window: int = 7) -> list[dict]:
    """
    Daily W/R for the last 90 days, plus a rolling window hit rate.
    Returns list of {date, daily_win, daily_total, daily_hit_rate, rolling_hit_rate}.
    """
    with _db() as conn:
        rows = conn.execute("""
            SELECT pick_date,
                   SUM(CASE WHEN correct=1 THEN 1 ELSE 0 END) as won,
                   COUNT(*) as total
            FROM predictions
            WHERE result != 'pending'
              AND pick_date >= date('now', '-90 days')
            GROUP BY pick_date
            ORDER BY pick_date ASC
        """).fetchall()

    points = [{"date": r[0], "won": r[1], "total": r[2],
               "daily_hit_rate": round(r[1]/r[2], 4) if r[2] > 0 else None}
              for r in rows]

    # Rolling window hit rate
    for i, p in enumerate(points):
        window_rows = points[max(0, i - window + 1): i + 1]
        w = sum(x["won"] for x in window_rows)
        t = sum(x["total"] for x in window_rows)
        p[f"rolling_{window}d_hit_rate"] = round(w / t, 4) if t > 0 else None

    return points


def calibration_data(n_bins: int = 10) -> list[dict]:
    """
    Calibration: bucket predictions by model_prob, compare avg prob vs actual hit rate.
    Returns list of {prob_bin, avg_model_prob, actual_hit_rate, count}.
    """
    with _db() as conn:
        rows = conn.execute("""
            SELECT model_prob, correct
            FROM predictions
            WHERE result != 'pending'
              AND model_prob IS NOT NULL
              AND correct IS NOT NULL
        """).fetchall()

    if not rows:
        return []

    df = pd.DataFrame(rows, columns=["model_prob", "correct"])
    df["bin"] = pd.cut(df["model_prob"], bins=n_bins, labels=False)
    grouped = df.groupby("bin").agg(
        avg_prob=("model_prob", "mean"),
        hit_rate=("correct", "mean"),
        count=("correct", "count"),
    ).reset_index()

    return [
        {
            "prob_bin": round(float(r["avg_prob"]), 3),
            "avg_model_prob": round(float(r["avg_prob"]), 3),
            "actual_hit_rate": round(float(r["hit_rate"]), 3),
            "count": int(r["count"]),
        }
        for _, r in grouped.iterrows()
        if not pd.isna(r["avg_prob"])
    ]


# Initialise on import
init_predictions_table()
