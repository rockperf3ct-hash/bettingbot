from __future__ import annotations

import json
import os
import sqlite3
import sys
import time as _time_module
import datetime as _dt
import hashlib
import traceback
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Module-level in-process cache for the schedule (persists across requests in same worker)
_CACHE: dict = {}
_SCHEDULE_TTL = 300  # 5 minutes
_PLAYER_MIN_AVG_CACHE: dict[str, tuple[float | None, float]] = {}
_PLAYER_MIN_AVG_TTL = 1800  # 30 minutes
_PROP_CLOSE_LINES_CACHE: tuple[dict[tuple[str, str, str], float], dict[tuple[str, str], float], float] | None = None
_PROP_CLOSE_LINES_TTL = 300  # 5 minutes

# Allow imports from project root
sys.path.insert(0, str(Path(__file__).parent.parent))

def _default_data_dir() -> str:
    if os.getenv("DATA_DIR"):
        return os.getenv("DATA_DIR", "data")
    if os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
        return "/tmp/data"
    return "data"


ARTIFACTS_DIR = Path(os.getenv("ARTIFACTS_DIR", "artifacts"))
DATA_DIR = Path(_default_data_dir())

app = FastAPI(title="Sports Model API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """Return structured JSON for unexpected 500s so frontend shows actionable errors."""
    tb = traceback.format_exc(limit=25)
    detail = f"{type(exc).__name__}: {exc}"
    return JSONResponse(
        status_code=500,
        content={
            "detail": detail,
            "path": request.url.path,
            "method": request.method,
            "traceback": tb,
        },
    )


@app.on_event("startup")
async def _startup_prewarm():
    """Pre-warm NBA box score cache in background so first ML prop request is fast."""
    import threading
    def _bg():
        try:
            from sports_model.nba_stats import prewarm_box_cache
            prewarm_box_cache()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("NBA box prewarm error: %s", exc)
    threading.Thread(target=_bg, daemon=True).start()


def _read_json(path: Path) -> dict:
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{path.name} not found. Run the pipeline first.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _df_to_records(df: pd.DataFrame) -> list[dict]:
    """Convert DataFrame to JSON-safe records: handles pd.NA, Timestamps, numpy types."""
    # Cast to object first so pd.NA in StringArray becomes NaN, then replace with None
    df = df.astype(object).where(pd.notnull(df.astype(object)), None)
    records = df.to_dict(orient="records")
    # Convert any remaining non-serializable types (Timestamps, numpy scalars)
    clean = []
    for row in records:
        clean.append({
            k: (v.isoformat() if hasattr(v, "isoformat") else
                int(v) if hasattr(v, "item") and isinstance(v.item(), int) else
                float(v) if hasattr(v, "item") else v)
            for k, v in row.items()
        })
    return clean


def _read_csv(path: Path) -> list[dict]:
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{path.name} not found.")
    df = pd.read_csv(path)
    return _df_to_records(df)


def _get_player_avg_minutes(player_name: str) -> float | None:
    if not player_name:
        return None
    now = _time_module.time()
    cached = _PLAYER_MIN_AVG_CACHE.get(player_name)
    if cached and (now - cached[1] < _PLAYER_MIN_AVG_TTL):
        return cached[0]
    try:
        from sports_model.nba_stats import get_player_game_log
        logs = get_player_game_log(player_name, n_games=8)
        mins = [g.get("MIN") for g in logs if isinstance(g.get("MIN"), (int, float))]
        avg = round(sum(mins) / len(mins), 1) if mins else None
    except Exception:
        avg = None
    _PLAYER_MIN_AVG_CACHE[player_name] = (avg, now)
    return avg


# ---------------------------------------------------------------------------
# AI Props History (paper performance)
# ---------------------------------------------------------------------------

_PROP_HIST_DB = DATA_DIR / "tracker.db"


def _prop_hist_connect() -> sqlite3.Connection:
    _PROP_HIST_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_PROP_HIST_DB)
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _ensure_columns(conn: sqlite3.Connection, table_name: str, required_cols: dict[str, str]) -> None:
    if not _table_exists(conn, table_name):
        return
    existing = {
        str(r[1])
        for r in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    for col, col_def in required_cols.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {col_def}")


def _prop_hist_init() -> None:
    with _prop_hist_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_prop_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                logged_at TEXT NOT NULL,
                pick_date TEXT NOT NULL,
                event_id TEXT,
                player TEXT NOT NULL,
                team TEXT,
                opponent TEXT,
                market TEXT NOT NULL,
                line REAL NOT NULL,
                call TEXT NOT NULL,
                confidence REAL,
                tier TEXT,
                result TEXT NOT NULL DEFAULT 'pending',
                actual_value REAL,
                game_date TEXT,
                resolved_at TEXT,
                close_line REAL,
                clv REAL,
                close_checked_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prop_unique
            ON ai_prop_history(pick_date, event_id, player, market, line, call)
            """
        )
        _ensure_columns(
            conn,
            "ai_prop_history",
            {
                "event_id": "event_id TEXT",
                "team": "team TEXT",
                "opponent": "opponent TEXT",
                "confidence": "confidence REAL",
                "tier": "tier TEXT",
                "result": "result TEXT NOT NULL DEFAULT 'pending'",
                "actual_value": "actual_value REAL",
                "game_date": "game_date TEXT",
                "resolved_at": "resolved_at TEXT",
                "close_line": "close_line REAL",
                "clv": "clv REAL",
                "close_checked_at": "close_checked_at TEXT",
            },
        )


def _get_close_line_maps() -> tuple[dict[tuple[str, str, str], float], dict[tuple[str, str], float]]:
    """
    Build close-line maps from local snapshot DB only (no extra Odds API calls).

    Source priority:
      - data/tracker.db -> nba_open_props snapshot rows
      - fallback empty maps if snapshot table missing
    """
    global _PROP_CLOSE_LINES_CACHE
    now = _time_module.time()
    if _PROP_CLOSE_LINES_CACHE and now - _PROP_CLOSE_LINES_CACHE[2] < _PROP_CLOSE_LINES_TTL:
        return _PROP_CLOSE_LINES_CACHE[0], _PROP_CLOSE_LINES_CACHE[1]

    event_map: dict[tuple[str, str, str], float] = {}
    player_map: dict[tuple[str, str], float] = {}
    try:
        with _prop_hist_connect() as conn:
            if _table_exists(conn, "nba_open_props"):
                rows = conn.execute(
                    """
                    SELECT event_id, player, market, line
                    FROM nba_open_props
                    WHERE player IS NOT NULL AND market IS NOT NULL AND line IS NOT NULL
                    """
                ).fetchall()
                for r in rows:
                    ev_id = str(r["event_id"] or "").strip()
                    player = str(r["player"] or "").strip()
                    market = str(r["market"] or "").strip()
                    line = r["line"]
                    if not ev_id or not player or not market or not isinstance(line, (int, float)):
                        continue
                    event_map[(ev_id, player, market)] = float(line)
                    player_map[(player, market)] = float(line)
    except Exception:
        event_map = {}
        player_map = {}

    _PROP_CLOSE_LINES_CACHE = (event_map, player_map, now)
    return event_map, player_map


def _market_calibration_factors() -> dict[str, float]:
    """Estimate per-market confidence multipliers from settled history with shrinkage."""
    _prop_hist_init()
    out: dict[str, float] = {}
    with _prop_hist_connect() as conn:
        rows = conn.execute(
            """
            SELECT market,
                   COUNT(*) AS n,
                   AVG(CASE WHEN result='won' THEN 1.0 WHEN result='lost' THEN 0.0 END) AS hit_rate,
                   AVG(CASE WHEN confidence BETWEEN 0.5 AND 0.97 THEN confidence END) AS avg_conf
            FROM ai_prop_history
            WHERE result IN ('won','lost')
            GROUP BY market
            """
        ).fetchall()

    for r in rows:
        market = str(r["market"] or "")
        n = int(r["n"] or 0)
        hit_rate = float(r["hit_rate"] or 0.5)
        avg_conf = float(r["avg_conf"] or 0.5)
        if not market or n < 12:
            continue
        drift = hit_rate - avg_conf
        shrink = n / (n + 40.0)
        factor = 1.0 + (0.65 * drift * shrink)
        out[market] = max(0.90, min(1.10, factor))
    return out


def _prop_stat_key(market: str) -> str:
    return {
        "player_points": "PTS",
        "player_rebounds": "REB",
        "player_assists": "AST",
        "player_threes": "3PT",
    }.get(market, "PTS")


def _log_ai_prop_preds(preds: list[dict]) -> None:
    if not preds:
        return
    _prop_hist_init()
    now_iso = _dt.datetime.now(_dt.timezone.utc).isoformat()
    pick_date = _dt.date.today().isoformat()
    with _prop_hist_connect() as conn:
        for p in preds:
            try:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO ai_prop_history
                    (logged_at, pick_date, event_id, player, team, opponent, market, line, call, confidence, tier)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        now_iso,
                        pick_date,
                        p.get("event_id"),
                        p.get("player"),
                        p.get("team"),
                        p.get("opponent"),
                        p.get("market"),
                        float(p.get("line") or 0),
                        p.get("call"),
                        float(p.get("confidence") or 0),
                        p.get("tier"),
                    ),
                )
            except Exception:
                continue


def _resolve_ai_prop_preds(limit: int = 400) -> None:
    _prop_hist_init()
    from sports_model.nba_stats import get_player_game_log
    ev_close_map, ply_close_map = _get_close_line_maps()

    with _prop_hist_connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM ai_prop_history
            WHERE result='pending'
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        for r in rows:
            player = r["player"]
            market = r["market"]
            stat = _prop_stat_key(market)
            pick_date = str(r["pick_date"] or "")
            team = str(r["team"] or "")
            opp = str(r["opponent"] or "")
            line = float(r["line"] or 0)
            call = str(r["call"] or "")

            try:
                logs = get_player_game_log(player, n_games=15)
            except Exception:
                logs = []
            if not logs:
                continue

            cand = None
            for g in logs:
                g_date = str(g.get("date") or "")
                if not g_date or g_date < pick_date:
                    continue
                if team and g.get("team") and str(g.get("team")) != team:
                    continue
                if opp and g.get("opponent") and str(g.get("opponent")) != opp:
                    continue
                cand = g
                break

            if cand is None:
                continue

            actual = cand.get(stat)
            if actual is None:
                continue

            if call == "Over":
                result = "won" if float(actual) > line else "lost" if float(actual) < line else "push"
            elif call == "Under":
                result = "won" if float(actual) < line else "lost" if float(actual) > line else "push"
            else:
                continue

            ev_id = str(r["event_id"] or "")
            close_line = ev_close_map.get((ev_id, player, market)) if ev_id else None
            if close_line is None:
                close_line = ply_close_map.get((player, market))
            clv = None
            if isinstance(close_line, (int, float)):
                if call == "Over":
                    clv = float(close_line) - line
                elif call == "Under":
                    clv = line - float(close_line)

            conn.execute(
                """
                UPDATE ai_prop_history
                SET result=?, actual_value=?, game_date=?, resolved_at=?, close_line=?, clv=?, close_checked_at=?
                WHERE id=?
                """,
                (
                    result,
                    float(actual),
                    cand.get("date"),
                    _dt.datetime.now(_dt.timezone.utc).isoformat(),
                    float(close_line) if isinstance(close_line, (int, float)) else None,
                    round(float(clv), 4) if isinstance(clv, (int, float)) else None,
                    _dt.datetime.now(_dt.timezone.utc).isoformat(),
                    int(r["id"]),
                ),
            )


def _ai_parlay_init() -> None:
    _prop_hist_init()
    with _prop_hist_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_prop_parlay_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                pick_date TEXT NOT NULL,
                kind TEXT NOT NULL,
                score REAL,
                result TEXT NOT NULL DEFAULT 'pending',
                legs_total INTEGER NOT NULL,
                legs_won INTEGER NOT NULL DEFAULT 0,
                legs_lost INTEGER NOT NULL DEFAULT 0,
                legs_push INTEGER NOT NULL DEFAULT 0,
                legs_pending INTEGER NOT NULL DEFAULT 0,
                settled_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_prop_parlay_legs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parlay_id INTEGER NOT NULL,
                leg_index INTEGER NOT NULL,
                player TEXT NOT NULL,
                market TEXT NOT NULL,
                line REAL NOT NULL,
                call TEXT NOT NULL,
                confidence REAL,
                tier TEXT,
                home_team TEXT,
                away_team TEXT,
                result TEXT NOT NULL DEFAULT 'pending',
                actual_value REAL,
                game_date TEXT,
                FOREIGN KEY(parlay_id) REFERENCES ai_prop_parlay_history(id)
            )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_parlay_leg_unique
            ON ai_prop_parlay_legs(parlay_id, leg_index)
            """
        )
        _ensure_columns(
            conn,
            "ai_prop_parlay_history",
            {
                "kind": "kind TEXT NOT NULL DEFAULT 'safe'",
                "score": "score REAL",
                "result": "result TEXT NOT NULL DEFAULT 'pending'",
                "legs_total": "legs_total INTEGER NOT NULL DEFAULT 0",
                "legs_won": "legs_won INTEGER NOT NULL DEFAULT 0",
                "legs_lost": "legs_lost INTEGER NOT NULL DEFAULT 0",
                "legs_push": "legs_push INTEGER NOT NULL DEFAULT 0",
                "legs_pending": "legs_pending INTEGER NOT NULL DEFAULT 0",
                "settled_at": "settled_at TEXT",
            },
        )
        _ensure_columns(
            conn,
            "ai_prop_parlay_legs",
            {
                "confidence": "confidence REAL",
                "tier": "tier TEXT",
                "home_team": "home_team TEXT",
                "away_team": "away_team TEXT",
                "result": "result TEXT NOT NULL DEFAULT 'pending'",
                "actual_value": "actual_value REAL",
                "game_date": "game_date TEXT",
                "close_line": "close_line REAL",
                "clv": "clv REAL",
            },
        )


def _log_ai_parlay(kind: str, score: float | None, legs: list[dict]) -> int | None:
    if not legs:
        return None
    _ai_parlay_init()
    now_iso = _dt.datetime.now(_dt.timezone.utc).isoformat()
    pick_date = _dt.date.today().isoformat()
    with _prop_hist_connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO ai_prop_parlay_history (created_at, pick_date, kind, score, legs_total)
            VALUES (?,?,?,?,?)
            """,
            (now_iso, pick_date, kind, float(score or 0), len(legs)),
        )
        pid = int(cur.lastrowid)
        for i, l in enumerate(legs):
            conn.execute(
                """
                INSERT INTO ai_prop_parlay_legs
                (parlay_id, leg_index, player, market, line, call, confidence, tier, home_team, away_team)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    pid,
                    i,
                    l.get("player"),
                    l.get("market"),
                    float(l.get("line") or 0),
                    l.get("call"),
                    float(l.get("confidence") or 0),
                    l.get("tier"),
                    l.get("home_team"),
                    l.get("away_team"),
                ),
            )
    return pid


def _resolve_ai_parlays(limit: int = 120) -> None:
    _ai_parlay_init()
    _resolve_ai_prop_preds(limit=600)
    with _prop_hist_connect() as conn:
        pars = conn.execute(
            """
            SELECT * FROM ai_prop_parlay_history
            WHERE result='pending'
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        for p in pars:
            legs = conn.execute(
                """
                SELECT * FROM ai_prop_parlay_legs WHERE parlay_id=? ORDER BY leg_index ASC
                """,
                (int(p["id"]),),
            ).fetchall()
            if not legs:
                continue

            w = l = pu = pe = 0
            for leg in legs:
                row = conn.execute(
                    """
                    SELECT result, actual_value, game_date, close_line, clv
                    FROM ai_prop_history
                    WHERE player=? AND market=? AND line=? AND call=? AND pick_date>=?
                    ORDER BY id ASC
                    LIMIT 1
                    """,
                    (
                        leg["player"],
                        leg["market"],
                        float(leg["line"]),
                        leg["call"],
                        p["pick_date"],
                    ),
                ).fetchone()

                leg_res = "pending"
                leg_val = None
                leg_day = None
                leg_close_line = None
                leg_clv = None
                if row:
                    leg_res = str(row["result"] or "pending")
                    leg_val = row["actual_value"]
                    leg_day = row["game_date"]
                    leg_close_line = row["close_line"] if "close_line" in row.keys() else None
                    leg_clv = row["clv"] if "clv" in row.keys() else None

                if leg_res == "won":
                    w += 1
                elif leg_res == "lost":
                    l += 1
                elif leg_res == "push":
                    pu += 1
                else:
                    pe += 1

                conn.execute(
                    """
                    UPDATE ai_prop_parlay_legs
                    SET result=?, actual_value=?, game_date=?, close_line=?, clv=?
                    WHERE id=?
                    """,
                    (leg_res, leg_val, leg_day, leg_close_line, leg_clv, int(leg["id"])),
                )

            final_res = "pending"
            if pe == 0:
                if l > 0:
                    final_res = "lost"
                elif w > 0:
                    final_res = "won"
                else:
                    final_res = "push"

            conn.execute(
                """
                UPDATE ai_prop_parlay_history
                SET result=?, legs_won=?, legs_lost=?, legs_push=?, legs_pending=?, settled_at=?
                WHERE id=?
                """,
                (
                    final_res,
                    w,
                    l,
                    pu,
                    pe,
                    _dt.datetime.now(_dt.timezone.utc).isoformat() if final_res != "pending" else None,
                    int(p["id"]),
                ),
            )


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/summary")
def summary():
    data = _read_json(ARTIFACTS_DIR / "backtest_summary.json")
    return data


@app.get("/api/metrics")
def metrics():
    return _read_json(ARTIFACTS_DIR / "metrics.json")


@app.get("/api/benchmark")
def benchmark():
    return _read_json(ARTIFACTS_DIR / "model_benchmark.json")


@app.get("/api/bets")
def bets(limit: int = 500, offset: int = 0, league: str | None = None, side: str | None = None):
    records = _read_csv(ARTIFACTS_DIR / "backtest_bets.csv")
    if league:
        records = [r for r in records if r.get("league") == league]
    if side:
        records = [r for r in records if r.get("bet_side") == side]
    total = len(records)
    sliced = records[offset: offset + limit]
    return {"total": total, "offset": offset, "limit": limit, "bets": sliced}


@app.get("/api/bets/leagues")
def leagues():
    records = _read_csv(ARTIFACTS_DIR / "backtest_bets.csv")
    raw: list[str] = [str(r["league"]) for r in records if r.get("league")]
    vals: list[str] = sorted(list(set(raw)))
    return {"leagues": vals}


@app.get("/api/bets/equity")
def equity():
    records = _read_csv(ARTIFACTS_DIR / "backtest_bets.csv")
    placed = [r for r in records if r.get("bet_side")]
    return [{"date": r.get("date"), "bankroll": r.get("bankroll"), "pnl": r.get("pnl")} for r in placed]


@app.get("/api/odds")
def odds(limit: int = 200):
    records = _read_csv(DATA_DIR / "odds_snapshots.csv")
    h2h = [r for r in records if r.get("market") == "h2h"]
    seen: dict[str, dict] = {}
    for r in h2h:
        key = f"{r.get('event_id')}_{r.get('outcome_name')}"
        seen[key] = r
    latest = list(seen.values())[:limit]
    return {"total": len(latest), "odds": latest}


@app.get("/api/enriched")
def enriched(limit: int = 50):
    records = _read_csv(DATA_DIR / "enriched_games.csv")
    return {"total": len(records), "games": records[:limit]}


@app.get("/api/scoreboard")
def scoreboard_all():
    """Fetch live/today's scoreboard across all ESPN leagues + MLB."""
    try:
        from sports_model.espn_ingest import fetch_live_scoreboard
        df = fetch_live_scoreboard()
        if df.empty:
            return {"total": 0, "games": []}
        return {"total": len(df), "games": _df_to_records(df)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/scoreboard/{league_slug}")
def scoreboard_league(league_slug: str, game_date: str | None = None):
    """
    Fetch scoreboard for a specific league slug.

    league_slug: one of epl, bundesliga, laliga, liga_mx, ucl, europa, nba, mlb
    game_date: optional YYYY-MM-DD (default: today)
    """
    try:
        from datetime import date as date_type
        from sports_model.espn_ingest import ESPN_LEAGUES, fetch_espn_scoreboard, fetch_mlb_scoreboard

        parsed_date = date_type.fromisoformat(game_date) if game_date else None

        if league_slug == "mlb":
            rows = fetch_mlb_scoreboard(game_date=parsed_date)
        elif league_slug in ESPN_LEAGUES:
            rows = fetch_espn_scoreboard(league_slug, game_date=parsed_date)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown league '{league_slug}'. Valid: {list(ESPN_LEAGUES) + ['mlb']}"
            )

        df = pd.DataFrame(rows)
        if df.empty:
            return {"league": league_slug, "total": 0, "games": []}
        return {"league": league_slug, "total": len(df), "games": _df_to_records(df)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/standings")
def standings_all():
    """Fetch current standings for all leagues (soccer + NBA) from ESPN."""
    try:
        from sports_model.standings import fetch_all_standings
        df = fetch_all_standings()
        if df.empty:
            return {"total": 0, "standings": []}
        return {"total": len(df), "standings": _df_to_records(df)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/standings/mlb-preseason")
def standings_mlb_preseason():
    """Fetch MLB Spring Training standings (Cactus League + Grapefruit League) for current season."""
    try:
        from sports_model.standings import fetch_mlb_preseason
        df = fetch_mlb_preseason(season=2026)
        if df.empty:
            return {"league": "mlb_preseason", "total": 0, "standings": []}
        return {"league": "mlb_preseason", "total": len(df), "standings": _df_to_records(df)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/standings/{league_slug}")
def standings_league(league_slug: str):
    """Fetch standings for a specific league slug (epl, bundesliga, laliga, liga_mx, ucl, europa, nba, mlb)."""
    try:
        from sports_model.standings import fetch_espn_standings
        df = fetch_espn_standings(league_slug)
        if df.empty:
            return {"league": league_slug, "total": 0, "standings": []}
        return {"league": league_slug, "total": len(df), "standings": _df_to_records(df)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/team-meta/{team_name}")
def team_meta(team_name: str):
    """Fetch team logo, badge colour, and country from TheSportsDB."""
    try:
        from sports_model.standings import fetch_team_meta
        meta = fetch_team_meta(team_name)
        return {"team": team_name, **meta}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/sport-summary")
def sport_summary():
    """Return combined multi-sport model summary (sport-specific models)."""
    return _read_json(ARTIFACTS_DIR / "multi_model_summary.json")


@app.get("/api/sport-summary/{sport}")
def sport_summary_single(sport: str):
    """Return backtest summary for a specific sport model (soccer/nba/mlb)."""
    return _read_json(ARTIFACTS_DIR / f"{sport}_backtest_summary.json")


@app.get("/api/sport-bets/{sport}")
def sport_bets(sport: str, limit: int = 500, offset: int = 0):
    """Return backtest bets for a specific sport model."""
    records = _read_csv(ARTIFACTS_DIR / f"{sport}_backtest_bets.csv")
    placed  = [r for r in records if r.get("bet_side")]
    total   = len(placed)
    return {"sport": sport, "total": total, "offset": offset,
            "limit": limit, "bets": placed[offset: offset + limit]}


@app.get("/api/sport-metrics/{sport}")
def sport_metrics(sport: str):
    """Return walk-forward metrics for a specific sport model."""
    return _read_json(ARTIFACTS_DIR / f"{sport}_metrics.json")


@app.get("/api/picks/today")
def picks_today(top_n: int = 10):
    """
    Fast ML-only picks for today — no Gemini call.
    Returns picks + parlay in ~1-2s. Use /api/picks/today/narrative for AI text.
    """
    try:
        from sports_model.recommendations import score_todays_games, _build_parlay
        picks = score_todays_games(top_n=top_n)
        return {"date": __import__("datetime").date.today().isoformat(), "picks": picks, "parlay": _build_parlay(picks)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/picks/tomorrow")
def picks_tomorrow(top_n: int = 10):
    """
    Fast ML-only picks for tomorrow — no Gemini call.
    Returns picks + parlay in ~1-2s. Use /api/picks/tomorrow/narrative for AI text.
    """
    try:
        from sports_model.recommendations import score_tomorrows_games, _build_parlay
        from datetime import date, timedelta
        picks = score_tomorrows_games(top_n=top_n)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        return {"date": tomorrow, "picks": picks, "parlay": _build_parlay(picks)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/picks/today/winners")
def picks_today_winners(top_n: int = 10):
    """Winner recommendations with model win probability (no edge filtering)."""
    try:
        from sports_model.recommendations import score_todays_winners
        return {"date": __import__("datetime").date.today().isoformat(), "picks": score_todays_winners(top_n=top_n), "parlay": None}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/picks/tomorrow/winners")
def picks_tomorrow_winners(top_n: int = 10):
    """Tomorrow winner recommendations with model win probability (no edge filtering)."""
    try:
        from sports_model.recommendations import score_tomorrows_winners
        from datetime import date, timedelta
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        return {"date": tomorrow, "picks": score_tomorrows_winners(top_n=top_n), "parlay": None}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/picks/today/narrative")
def picks_today_narrative(top_n: int = 10):
    """Gemini narrative for today's picks (slow — 4-10s). Call after /api/picks/today loads."""
    try:
        from sports_model.recommendations import build_recommendations
        return build_recommendations(top_n=top_n)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/picks/tomorrow/narrative")
def picks_tomorrow_narrative(top_n: int = 10):
    """Gemini narrative for tomorrow's picks (slow — 4-10s). Call after /api/picks/tomorrow loads."""
    try:
        from sports_model.recommendations import build_recommendations_tomorrow
        return build_recommendations_tomorrow(top_n=top_n)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/recommendations")
def recommendations(top_n: int = 8):
    """
    AI-powered bet recommendations for today's slate.
    Scores today's upcoming games with our ML models, ranks by edge,
    then calls Gemini for narrative analysis and parlay suggestion.
    NOTE: Slow (4-10s) due to Gemini call. Use /api/picks/today for instant picks.
    """
    try:
        from sports_model.recommendations import build_recommendations
        result = build_recommendations(top_n=top_n)
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/recommendations/tomorrow")
def recommendations_tomorrow(top_n: int = 8):
    """Score tomorrow's scheduled games with Gemini narrative and parlay suggestion.
    NOTE: Slow (4-10s). Use /api/picks/tomorrow for instant picks."""
    try:
        from sports_model.recommendations import build_recommendations_tomorrow
        return build_recommendations_tomorrow(top_n=top_n)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# NBA Player Props
# ---------------------------------------------------------------------------

@app.get("/api/props/nba")
def nba_props_all():
    """
    Fetch NBA player props (points/rebounds/assists) for all upcoming games today.
    Returns list of games, each with their player props from FanDuel/DraftKings.
    Cached 15 min per event.
    """
    try:
        from sports_model.live_odds import get_nba_event_ids, fetch_nba_player_props
        events = get_nba_event_ids()
        result = []
        for ev in events:
            props = fetch_nba_player_props(
                ev["event_id"], ev["home_team"], ev["away_team"]
            )
            result.append({
                "event_id":      ev["event_id"],
                "home_team":     ev["home_team"],
                "away_team":     ev["away_team"],
                "commence_time": ev["commence_time"],
                "props":         props,
            })
        return {"games": result, "total_props": sum(len(g["props"]) for g in result)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


_PROP_PRED_CACHE: dict = {}
_PROP_PRED_TTL = 1800  # 30 min


def _devig_prob(over_odds: float | None, under_odds: float | None) -> tuple[float, float]:
    """De-vig over/under decimal odds → true implied probabilities."""
    if not over_odds or not under_odds or over_odds <= 1 or under_odds <= 1:
        return 0.5, 0.5
    p_over  = 1.0 / over_odds
    p_under = 1.0 / under_odds
    total   = p_over + p_under
    return round(p_over / total, 4), round(p_under / total, 4)


def _predict_prop(prop: dict) -> dict:
    """Over/Under prediction via de-vigged implied probability."""
    over_prob, under_prob = _devig_prob(prop.get("over_odds"), prop.get("under_odds"))
    if over_prob >= under_prob:
        call, confidence, call_odds = "Over",  over_prob,  prop.get("over_odds")
    else:
        call, confidence, call_odds = "Under", under_prob, prop.get("under_odds")
    edge = round(confidence - 0.5, 4)
    tier = "Strong" if edge >= 0.10 else "Moderate" if edge >= 0.05 else "Lean"
    return {
        "player":           prop["player"],
        "market":           prop["market"],
        "market_label":     prop["market_label"],
        "line":             prop["line"],
        "call":             call,
        "confidence":       confidence,
        "over_prob":        over_prob,
        "under_prob":       under_prob,
        "edge":             edge,
        "tier":             tier,
        "call_odds":        call_odds,
        "over_odds":        prop.get("over_odds"),
        "under_odds":       prop.get("under_odds"),
        "best_bk":          prop.get("best_bk"),
        "fanduel_over":     prop.get("fanduel_over"),
        "fanduel_under":    prop.get("fanduel_under"),
        "draftkings_over":  prop.get("draftkings_over"),
        "draftkings_under": prop.get("draftkings_under"),
        "home_team":        prop.get("home_team"),
        "away_team":        prop.get("away_team"),
        "event_id":         prop.get("event_id"),
    }


# MUST be registered before /api/props/nba/{event_id} to avoid wildcard match
@app.get("/api/props/nba/predictions")
def nba_prop_predictions(market: str = "all", min_edge: float = 0.0, tier: str = "all"):
    """Over/Under predictions for all NBA player props today. Cached 30 min."""
    cache_key = "nba_prop_preds"
    now = _time_module.time()
    cached_entry = _PROP_PRED_CACHE.get(cache_key)
    preds = None
    if cached_entry:
        preds, ts = cached_entry
        if now - ts >= _PROP_PRED_TTL:
            preds = None

    if preds is None:
        try:
            from sports_model.live_odds import get_nba_event_ids, fetch_nba_player_props
            events = get_nba_event_ids()
            raw: list[dict] = []
            for ev in events:
                props = fetch_nba_player_props(ev["event_id"], ev["home_team"], ev["away_team"])
                for prop in props:
                    pred = _predict_prop(prop)
                    pred["commence_time"] = ev.get("commence_time")
                    raw.append(pred)
            raw.sort(key=lambda p: p["confidence"], reverse=True)
            preds = raw
            _PROP_PRED_CACHE[cache_key] = (preds, now)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    filtered = preds
    if market != "all":
        filtered = [p for p in filtered if p["market"] == market]
    if min_edge > 0:
        filtered = [p for p in filtered if p["edge"] >= min_edge]
    if tier != "all":
        filtered = [p for p in filtered if p["tier"] == tier]

    return {
        "predictions": filtered,
        "total":    len(filtered),
        "strong":   sum(1 for p in filtered if p["tier"] == "Strong"),
        "moderate": sum(1 for p in filtered if p["tier"] == "Moderate"),
        "lean":     sum(1 for p in filtered if p["tier"] == "Lean"),
    }


# ---------------------------------------------------------------------------
# NBA Player Prop ML Predictions (NBA Stats API game logs)
# ---------------------------------------------------------------------------

_ML_PROP_CACHE: dict = {}
_ML_PROP_TTL = 1800

# Only run ML predictions for these 3 markets (PTS/REB/AST)
_ML_MARKETS = {"player_points", "player_rebounds", "player_assists", "player_threes"}


@app.get("/api/props/nba/ml-predictions")
def nba_prop_ml_predictions(market: str = "all", tier: str = "all", min_edge: float = 0.0, line_mode: str = "open"):
    """
    ML-powered Over/Under predictions using player game logs from NBA Stats API.
    Uses rolling mean, std, recency and hit-rate signals vs the prop line.
    Covers Points, Rebounds, Assists. Cached 30 min.
    """
    cache_key = f"ml_prop_preds_{line_mode}"
    now = _time_module.time()
    cached_entry = _ML_PROP_CACHE.get(cache_key)
    preds = None
    if cached_entry:
        raw_preds, ts = cached_entry
        if raw_preds and now - ts < _ML_PROP_TTL:
            preds = raw_preds

    if preds is None:
        try:
            from sports_model.live_odds import get_nba_event_ids, fetch_nba_player_props, fetch_nba_player_props_open
            from sports_model.nba_stats import predict_prop, get_player_game_log
            market_cal = _market_calibration_factors()

            events = get_nba_event_ids()
            raw: list[dict] = []
            seen: set[str] = set()

            for ev in events:
                if line_mode == "live":
                    props = fetch_nba_player_props(ev["event_id"], ev["home_team"], ev["away_team"])
                else:
                    props = fetch_nba_player_props_open(ev["event_id"], ev["home_team"], ev["away_team"])
                for prop in props:
                    mkt = prop.get("market", "")
                    if mkt not in _ML_MARKETS:
                        continue
                    player = prop.get("player", "")
                    dedup_key = f"{player}_{mkt}"
                    if dedup_key in seen:
                        continue
                    seen.add(dedup_key)

                    def _norm(s: str | None) -> str:
                        return str(s or "").strip().lower()

                    team_name = prop.get("team")
                    home_team = ev.get("home_team")
                    away_team = ev.get("away_team")
                    team_norm = _norm(team_name)
                    home_norm = _norm(home_team)
                    away_norm = _norm(away_team)

                    if team_norm and team_norm == home_norm:
                        mapped_team = home_team
                        mapped_opp = away_team
                        team_odds = ev.get("home_odds")
                        opp_odds = ev.get("away_odds")
                    elif team_norm and team_norm == away_norm:
                        mapped_team = away_team
                        mapped_opp = home_team
                        team_odds = ev.get("away_odds")
                        opp_odds = ev.get("home_odds")
                    else:
                        inferred_team = None
                        try:
                            gl = get_player_game_log(player, n_games=2)
                            inferred_team = next((g.get("team") for g in gl if g.get("team")), None)
                        except Exception:
                            inferred_team = None

                        inf_norm = _norm(inferred_team)
                        if inf_norm and inf_norm == home_norm:
                            mapped_team = home_team
                            mapped_opp = away_team
                            team_odds = ev.get("home_odds")
                            opp_odds = ev.get("away_odds")
                        elif inf_norm and inf_norm == away_norm:
                            mapped_team = away_team
                            mapped_opp = home_team
                            team_odds = ev.get("away_odds")
                            opp_odds = ev.get("home_odds")
                        else:
                            mapped_team = inferred_team or team_name or None
                            mapped_opp = prop.get("opponent") or None
                            team_odds = None
                            opp_odds = None

                    pred = predict_prop(
                        player_name=player,
                        market=mkt,
                        line=prop.get("line", 0),
                        over_odds=prop.get("over_odds"),
                        under_odds=prop.get("under_odds"),
                        event_id=ev.get("event_id"),
                        team_name=mapped_team,
                        opponent_name=mapped_opp,
                        team_odds=team_odds,
                        opp_odds=opp_odds,
                        fanduel_line=prop.get("fanduel_line"),
                        draftkings_line=prop.get("draftkings_line"),
                    )
                    if pred is None:
                        continue

                    cal_factor = float(market_cal.get(mkt, 1.0))
                    if cal_factor != 1.0 and isinstance(pred.get("confidence"), (int, float)):
                        base_conf = float(pred.get("confidence") or 0.5)
                        adj_conf = max(0.50, min(0.97, base_conf * cal_factor))
                        pred["confidence"] = round(adj_conf, 4)
                        pred["edge"] = round(adj_conf - 0.5, 4)
                        pred["tier"] = "Strong" if pred["edge"] >= 0.10 else "Moderate" if pred["edge"] >= 0.05 else "Lean"
                        try:
                            ctx = pred.get("context") or {}
                            ctx["market_live_calibration"] = round(cal_factor, 4)
                            pred["context"] = ctx
                        except Exception:
                            pass

                    pred["home_team"]     = ev.get("home_team")
                    pred["away_team"]     = ev.get("away_team")
                    pred["team"]          = prop.get("team") or (pred.get("context", {}) or {}).get("team")
                    pred["opponent"]      = prop.get("opponent") or (pred.get("context", {}) or {}).get("opponent")
                    pred["team_logo"]     = prop.get("team_logo") or pred.get("team_logo")
                    pred["opponent_logo"] = prop.get("opponent_logo") or pred.get("opponent_logo")
                    pred["player_headshot"] = prop.get("player_headshot") or pred.get("player_headshot")
                    pred["event_id"]      = ev.get("event_id")
                    pred["commence_time"] = ev.get("commence_time")
                    pred["fanduel_over"]  = prop.get("fanduel_over")
                    pred["fanduel_under"] = prop.get("fanduel_under")
                    pred["draftkings_over"]  = prop.get("draftkings_over")
                    pred["draftkings_under"] = prop.get("draftkings_under")
                    raw.append(pred)
                    _time_module.sleep(0.05)  # gentle rate limit

            raw.sort(key=lambda p: p["confidence"], reverse=True)
            if raw:
                preds = raw
                _ML_PROP_CACHE[cache_key] = (preds, now)
                try:
                    _log_ai_prop_preds(preds)
                    _resolve_ai_prop_preds(limit=500)
                except Exception:
                    pass
            else:
                # Keep last known non-empty snapshot if upstream odds/props are temporarily empty
                if cached_entry and cached_entry[0]:
                    preds = cached_entry[0]
                else:
                    preds = []
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    filtered = preds
    if market != "all":
        filtered = [p for p in filtered if p["market"] == market]
    if tier != "all":
        filtered = [p for p in filtered if p["tier"] == tier]
    if min_edge > 0:
        filtered = [p for p in filtered if p["edge"] >= min_edge]

    return {
        "predictions": filtered,
        "total":    len(filtered),
        "strong":   sum(1 for p in filtered if p["tier"] == "Strong"),
        "moderate": sum(1 for p in filtered if p["tier"] == "Moderate"),
        "lean":     sum(1 for p in filtered if p["tier"] == "Lean"),
        "data_source": "NBA Stats API (game logs)",
        "markets_covered": list(_ML_MARKETS),
        "line_mode": line_mode,
    }


@app.get("/api/props/nba/ml-history")
def nba_prop_ml_history(limit: int = 120):
    """Paper history of AI prop predictions (won/lost/push/pending)."""
    try:
        _prop_hist_init()
        _resolve_ai_prop_preds(limit=600)

        with _prop_hist_connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM ai_prop_history").fetchone()[0]
            won = conn.execute("SELECT COUNT(*) FROM ai_prop_history WHERE result='won'").fetchone()[0]
            lost = conn.execute("SELECT COUNT(*) FROM ai_prop_history WHERE result='lost'").fetchone()[0]
            push = conn.execute("SELECT COUNT(*) FROM ai_prop_history WHERE result='push'").fetchone()[0]
            pending = conn.execute("SELECT COUNT(*) FROM ai_prop_history WHERE result='pending'").fetchone()[0]
            settled = won + lost + push
            hit_rate = (won / (won + lost)) if (won + lost) else None
            clv_avg = conn.execute(
                "SELECT AVG(clv) FROM ai_prop_history WHERE result IN ('won','lost') AND clv IS NOT NULL"
            ).fetchone()[0]
            clv_pos = conn.execute(
                "SELECT COUNT(*) FROM ai_prop_history WHERE result IN ('won','lost') AND clv > 0"
            ).fetchone()[0]
            clv_count = conn.execute(
                "SELECT COUNT(*) FROM ai_prop_history WHERE result IN ('won','lost') AND clv IS NOT NULL"
            ).fetchone()[0]
            clv_pos_rate = (float(clv_pos) / float(clv_count)) if clv_count else None

            failed_rows = conn.execute(
                """
                SELECT id, pick_date, game_date, player, team, opponent, market, line, call, confidence, actual_value, result, close_line, clv
                FROM ai_prop_history
                WHERE result='lost'
                ORDER BY id DESC
                LIMIT ?
                """,
                (min(limit, 80),),
            ).fetchall()

            recent_rows = conn.execute(
                """
                SELECT id, pick_date, game_date, player, team, opponent, market, line, call, confidence, actual_value, result, close_line, clv
                FROM ai_prop_history
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        def _as_dict(rows):
            return [{k: r[k] for k in r.keys()} for r in rows]

        return {
            "summary": {
                "total": total,
                "settled": settled,
                "won": won,
                "lost": lost,
                "push": push,
                "pending": pending,
                "hit_rate": round(hit_rate, 4) if hit_rate is not None else None,
                "avg_clv": round(float(clv_avg), 4) if clv_avg is not None else None,
                "positive_clv_rate": round(float(clv_pos_rate), 4) if clv_pos_rate is not None else None,
            },
            "failed": _as_dict(failed_rows),
            "recent": _as_dict(recent_rows),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class AIParlayLegIn(BaseModel):
    player: str
    market: str
    line: float
    call: str
    confidence: float | None = None
    tier: str | None = None
    home_team: str | None = None
    away_team: str | None = None


class AIParlayLogIn(BaseModel):
    kind: str = "safe"
    score: float | None = None
    legs: list[AIParlayLegIn]


@app.post("/api/props/nba/parlays/log")
def nba_props_parlay_log(payload: AIParlayLogIn):
    try:
        legs = [l.model_dump() for l in (payload.legs or [])]
        pid = _log_ai_parlay(kind=payload.kind or "safe", score=payload.score, legs=legs)
        return {"ok": True, "parlay_id": pid}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/props/nba/parlays/history")
def nba_props_parlays_history(limit: int = 60):
    try:
        _ai_parlay_init()
        _resolve_ai_parlays(limit=240)
        with _prop_hist_connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM ai_prop_parlay_history").fetchone()[0]
            won = conn.execute("SELECT COUNT(*) FROM ai_prop_parlay_history WHERE result='won'").fetchone()[0]
            lost = conn.execute("SELECT COUNT(*) FROM ai_prop_parlay_history WHERE result='lost'").fetchone()[0]
            push = conn.execute("SELECT COUNT(*) FROM ai_prop_parlay_history WHERE result='push'").fetchone()[0]
            pending = conn.execute("SELECT COUNT(*) FROM ai_prop_parlay_history WHERE result='pending'").fetchone()[0]
            hit_rate = (won / (won + lost)) if (won + lost) else None

            rows = conn.execute(
                """
                SELECT * FROM ai_prop_parlay_history
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

            out = []
            for r in rows:
                legs = conn.execute(
                    """
                    SELECT leg_index, player, market, line, call, confidence, tier, home_team, away_team, result, actual_value, close_line, clv
                    FROM ai_prop_parlay_legs
                    WHERE parlay_id=?
                    ORDER BY leg_index ASC
                    """,
                    (int(r["id"]),),
                ).fetchall()
                out.append({
                    "id": r["id"],
                    "created_at": r["created_at"],
                    "pick_date": r["pick_date"],
                    "kind": r["kind"],
                    "score": r["score"],
                    "result": r["result"],
                    "legs_total": r["legs_total"],
                    "legs_won": r["legs_won"],
                    "legs_lost": r["legs_lost"],
                    "legs_push": r["legs_push"],
                    "legs_pending": r["legs_pending"],
                    "legs": [{k: lg[k] for k in lg.keys()} for lg in legs],
                })

        return {
            "summary": {
                "total": total,
                "won": won,
                "lost": lost,
                "push": push,
                "pending": pending,
                "hit_rate": round(hit_rate, 4) if hit_rate is not None else None,
            },
            "parlays": out,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/props/nba/open-lines/refresh")
def nba_open_lines_refresh(force_update: bool = False):
    """Manual refresh for NBA open-line snapshots to reduce recurring Odds API calls."""
    try:
        from sports_model.live_odds import refresh_nba_open_lines
        out = refresh_nba_open_lines(force_update=force_update)
        # clear derived caches so next read reflects latest snapshot mode
        _ML_PROP_CACHE.pop("ml_prop_preds_open", None)
        _ML_PROP_CACHE.pop("ml_prop_preds_live", None)
        return out
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/props/nba/live-tracking")
def nba_live_player_tracking():
    """
    Live player stat tracking for all today's NBA games.
    Merges live ESPN box scores with The Odds API prop lines so you can see
    each player's current stat vs their O/U line with a progress bar.

    Returns games with players, each having:
      - live stat (PTS/REB/AST/3PT/STL/BLK)
      - prop line from The Odds API
      - progress % toward the line
      - status: 'hitting' | 'needs_more' | 'final'
    """
    try:
        import requests as _req

        ESPN_BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
        _hdrs = {"User-Agent": "sports-model/1.0 (educational)"}

        # ── 1. Get today + tomorrow NBA games from ESPN ───────────────────────
        from datetime import datetime, timezone, timedelta
        now_utc      = datetime.now(timezone.utc)
        yday_date    = (now_utc - timedelta(days=1)).strftime("%Y-%m-%d")
        today_date   = now_utc.strftime("%Y-%m-%d")
        tmr_date     = (now_utc + timedelta(days=1)).strftime("%Y-%m-%d")
        yday_compact = (now_utc - timedelta(days=1)).strftime("%Y%m%d")
        today_compact = now_utc.strftime("%Y%m%d")
        tmr_compact   = (now_utc + timedelta(days=1)).strftime("%Y%m%d")

        # Fetch yesterday/today/tomorrow so late-night games are not missed
        sb_yday = _req.get(f"{ESPN_BASE_URL}/scoreboard",
            params={"dates": yday_compact}, headers=_hdrs, timeout=10).json()
        # Fetch today
        sb_today = _req.get(f"{ESPN_BASE_URL}/scoreboard",
            params={"dates": today_compact}, headers=_hdrs, timeout=10).json()
        # Fetch tomorrow (games posted early)
        sb_tmr = _req.get(f"{ESPN_BASE_URL}/scoreboard",
            params={"dates": tmr_compact}, headers=_hdrs, timeout=10).json()

        events = (sb_yday.get("events", []) + sb_today.get("events", []) + sb_tmr.get("events", []))
        # Keep yesterday/today/tomorrow and always retain live states
        filtered_events = []
        seen_ids: set[str] = set()
        for e in events:
            eid = str(e.get("id", ""))
            if not eid or eid in seen_ids:
                continue
            st_name = e.get("status", {}).get("type", {}).get("name", "")
            st_low = st_name.lower()
            is_live_state = (
                any(x in st_name for x in ("InProgress", "Halftime", "EndOfPeriod"))
                or "progress" in st_low
                or "halftime" in st_low
            )
            dt_str = e.get("date", "")
            in_window = (
                dt_str.startswith(yday_date)
                or dt_str.startswith(today_date)
                or dt_str.startswith(tmr_date)
            )
            if in_window or is_live_state:
                filtered_events.append(e)
                seen_ids.add(eid)
        events = filtered_events

        if not events:
            return {"games": [], "updated_at": _time_module.strftime("%H:%M:%S"),
                    "date": today_date}

        # ── 2. Get prop lines from Odds API (cached) ────────────────────────
        from sports_model.live_odds import get_nba_event_ids, fetch_nba_player_props

        odds_events = get_nba_event_ids()
        # Build lookup: normalize team name → {player → {market → line}}
        prop_lines: dict[str, dict[str, dict[str, float]]] = {}
        for ev in odds_events:
            props = fetch_nba_player_props(ev["event_id"], ev["home_team"], ev["away_team"])
            for p in props:
                player = p["player"]
                mkt    = p["market"]
                line   = p.get("line")
                over_odds  = p.get("over_odds")
                under_odds = p.get("under_odds")
                if player not in prop_lines:
                    prop_lines[player] = {}
                prop_lines[player][mkt] = {
                    "line": line,
                    "over_odds":  over_odds,
                    "under_odds": under_odds,
                    "fanduel_over":    p.get("fanduel_over"),
                    "fanduel_under":   p.get("fanduel_under"),
                    "draftkings_over": p.get("draftkings_over"),
                    "draftkings_under": p.get("draftkings_under"),
                }

        # Stat label → market key
        LABEL_TO_MARKET = {
            "PTS": "player_points",
            "REB": "player_rebounds",
            "AST": "player_assists",
            "3PT": "player_threes",
            "STL": "player_steals",
            "BLK": "player_blocks",
        }

        # ── 3. For each game fetch live box score & merge with lines ─────────
        games_out = []
        for event in events:
            eid    = event["id"]
            name   = event.get("name", "")
            status = event.get("status", {})
            period = status.get("period", 0)
            clock  = status.get("displayClock", "")
            state  = status.get("type", {}).get("name", "")
            is_live  = any(x in state for x in ("InProgress", "Halftime", "EndOfPeriod")) or "progress" in state.lower() or "halftime" in state.lower()
            is_final = "Final" in state or "final" in state.lower()

            comps = event.get("competitions", [{}])[0]
            competitors = comps.get("competitors", [])
            home_team = next((c["team"]["displayName"] for c in competitors if c.get("homeAway") == "home"), "")
            away_team = next((c["team"]["displayName"] for c in competitors if c.get("homeAway") == "away"), "")
            home_score = next((c.get("score", "0") for c in competitors if c.get("homeAway") == "home"), "0")
            away_score = next((c.get("score", "0") for c in competitors if c.get("homeAway") == "away"), "0")
            home_abbr = next((c["team"].get("abbreviation", "") for c in competitors if c.get("homeAway") == "home"), "")
            away_abbr = next((c["team"].get("abbreviation", "") for c in competitors if c.get("homeAway") == "away"), "")

            # Get commence time
            commence_time = comps.get("date", "")

            players_out = []
            avg_minutes_local: dict[str, float | None] = {}

            if is_live or is_final:
                # ── Live/Final: fetch box score stats ────────────────────────
                try:
                    summary = _req.get(f"{ESPN_BASE_URL}/summary",
                        params={"event": eid}, headers=_hdrs, timeout=10).json()
                except Exception:
                    summary = {}

                boxscore = summary.get("boxscore", {})

                for team_obj in boxscore.get("players", []):
                    team_name = team_obj.get("team", {}).get("displayName", "")
                    team_abbr = team_obj.get("team", {}).get("abbreviation", "")
                    for stats_obj in team_obj.get("statistics", []):
                        labels   = stats_obj.get("labels", [])
                        athletes = stats_obj.get("athletes", [])

                        for ath in athletes:
                            if ath.get("didNotPlay"):
                                continue
                            athlete = ath.get("athlete", {})
                            pname   = athlete.get("displayName", "")
                            raw     = ath.get("stats", []) or []
                            if not pname:
                                continue

                            stat_map: dict[str, int] = {}
                            minutes_played: int = 0
                            for lbl, val in zip(labels, raw):
                                if lbl == "MIN":
                                    try:
                                        minutes_played = int(str(val).split(":")[0])
                                    except Exception:
                                        minutes_played = 0
                                elif lbl in LABEL_TO_MARKET:
                                    try:
                                        stat_map[lbl] = int(str(val).split("-")[0])
                                    except Exception:
                                        stat_map[lbl] = 0
                            # Always include all 6 stats (fill missing with 0)
                            for lbl in ["PTS", "REB", "AST", "3PT", "STL", "BLK"]:
                                if lbl not in stat_map:
                                    stat_map[lbl] = 0

                            if not stat_map:
                                continue

                            player_props = prop_lines.get(pname, {})
                            tracked: list[dict] = []

                            for lbl, current_val in stat_map.items():
                                market    = LABEL_TO_MARKET[lbl]
                                line_data = player_props.get(market)
                                if not line_data or not line_data.get("line"):
                                    tracked.append({
                                        "stat": lbl, "market": market,
                                        "current": current_val, "line": None,
                                        "progress": None, "status": "no_line",
                                        "over_odds": None, "under_odds": None,
                                        "fanduel_over": None, "fanduel_under": None,
                                        "draftkings_over": None, "draftkings_under": None,
                                    })
                                    continue

                                line     = line_data["line"]
                                progress = round((current_val / line) * 100, 1) if line else None
                                if is_final:
                                    status_str = "hit" if current_val > line else "missed"
                                elif current_val >= line:
                                    status_str = "hit"
                                elif progress and progress >= 75:
                                    status_str = "close"
                                else:
                                    status_str = "needs_more"

                                tracked.append({
                                    "stat": lbl, "market": market,
                                    "current": current_val, "line": line,
                                    "progress": progress, "status": status_str,
                                    "over_odds":   line_data.get("over_odds"),
                                    "under_odds":  line_data.get("under_odds"),
                                    "fanduel_over":    line_data.get("fanduel_over"),
                                    "fanduel_under":   line_data.get("fanduel_under"),
                                    "draftkings_over": line_data.get("draftkings_over"),
                                    "draftkings_under": line_data.get("draftkings_under"),
                                })

                            if tracked:
                                if pname not in avg_minutes_local:
                                    avg_minutes_local[pname] = _get_player_avg_minutes(pname)
                                players_out.append({
                                    "player":    pname,
                                    "team":      team_name,
                                    "team_abbr": team_abbr,
                                    "minutes":   minutes_played,
                                    "avg_minutes": avg_minutes_local.get(pname),
                                    "props":     tracked,
                                })
            else:
                # ── Scheduled: build players from prop lines only (current=0) ─
                # Group props by player
                player_team_map: dict[str, str] = {}
                # All 6 stat labels we always want to show
                ALL_STAT_LABELS = ["PTS", "REB", "AST", "3PT", "STL", "BLK"]

                for ev in odds_events:
                    ht = ev.get("home_team", "")
                    at = ev.get("away_team", "")
                    if ht in (home_team, away_team) or at in (home_team, away_team):
                        props_for_game = fetch_nba_player_props(
                            ev["event_id"], ev["home_team"], ev["away_team"]
                        )

                        # Build per-player prop line lookup: {player: {lbl: prop_dict}}
                        player_lines: dict[str, dict] = {}
                        for prop in props_for_game:
                            pname = prop["player"]
                            mkt   = prop["market"]
                            lbl   = next((k for k, v in LABEL_TO_MARKET.items() if v == mkt), None)
                            if not lbl:
                                continue
                            if pname not in player_lines:
                                player_lines[pname] = {}
                            player_lines[pname][lbl] = prop

                        # Build player cards — always include all 6 stats
                        for pname, lbl_map in player_lines.items():
                            if pname not in avg_minutes_local:
                                avg_minutes_local[pname] = _get_player_avg_minutes(pname)
                            tracked: list[dict] = []
                            for lbl in ALL_STAT_LABELS:
                                mkt  = LABEL_TO_MARKET[lbl]
                                prop = lbl_map.get(lbl)
                                line = prop.get("line") if prop else None
                                tracked.append({
                                    "stat":    lbl,
                                    "market":  mkt,
                                    "current": 0,
                                    "line":    line,
                                    "progress": 0.0 if line else None,
                                    "status":  "scheduled" if line else "no_line",
                                    "over_odds":   prop.get("over_odds")  if prop else None,
                                    "under_odds":  prop.get("under_odds") if prop else None,
                                    "fanduel_over":    prop.get("fanduel_over")    if prop else None,
                                    "fanduel_under":   prop.get("fanduel_under")   if prop else None,
                                    "draftkings_over": prop.get("draftkings_over") if prop else None,
                                    "draftkings_under": prop.get("draftkings_under") if prop else None,
                                })
                            players_out.append({
                                    "player":    pname,
                                    "team":      home_team,
                                    "team_abbr": home_abbr,
                                    "minutes":   0,
                                    "avg_minutes": avg_minutes_local.get(pname),
                                    "props":     tracked,
                                })
                        break  # matched the game

            games_out.append({
                "event_id":      eid,
                "home_team":     home_team,
                "away_team":     away_team,
                "home_abbr":     home_abbr,
                "away_abbr":     away_abbr,
                "home_score":    home_score,
                "away_score":    away_score,
                "period":        period,
                "clock":         clock,
                "is_live":       is_live,
                "is_final":      is_final,
                "state":         state,
                "commence_time": commence_time,
                "players":       players_out,
            })

        return {
            "games":      games_out,
            "updated_at": _time_module.strftime("%H:%M:%S"),
            "total_games": len(games_out),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# NBA Game Feed — play-by-play + scoreline + win probability
# ---------------------------------------------------------------------------

_GAME_FEED_CACHE: dict = {}
_GAME_FEED_TTL = 25  # 25 sec for live games


@app.get("/api/nba/game-feed/{event_id}")
def nba_game_feed(event_id: str):
    """
    Real-time play-by-play, score, win probability and team stats for one NBA game.
    Cached 25s so auto-refresh every 30s stays fresh.
    """
    now = _time_module.time()
    if event_id in _GAME_FEED_CACHE:
        cached, ts = _GAME_FEED_CACHE[event_id]
        if now - ts < _GAME_FEED_TTL:
            return cached

    try:
        import requests as _req
        ESPN_BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
        hdrs = {"User-Agent": "sports-model/1.0 (educational)"}

        r = _req.get(f"{ESPN_BASE_URL}/summary", params={"event": event_id}, headers=hdrs, timeout=10)
        if r.status_code != 200:
            raise HTTPException(status_code=r.status_code, detail="ESPN feed unavailable")
        d = r.json()

        # ── Teams ────────────────────────────────────────────────────────────
        header     = d.get("header", {})
        comp       = header.get("competitions", [{}])[0]
        teams_info = {}
        linescore = {"home": [], "away": []}
        for c in comp.get("competitors", []):
            t    = c.get("team", {})
            side = c.get("homeAway", "home")
            teams_info[side] = {
                "id":           t.get("id", ""),
                "abbr":         t.get("abbreviation", ""),
                "name":         t.get("displayName", ""),
                "color":        t.get("color", "1a2a4a"),
                "alt_color":    t.get("alternateColor", "ffffff"),
                "logo":         t.get("logo", ""),
                "score":        c.get("score", "0"),
                "record":       c.get("record", [{}])[0].get("summary", "") if c.get("record") else "",
            }
            ls = []
            for per in c.get("linescores", []) or []:
                ls.append(str(per.get("displayValue", per.get("value", "-")) or "-"))
            while len(ls) < 4:
                ls.append("-")
            linescore[side] = ls[:4]

        # ── Status ───────────────────────────────────────────────────────────
        status = comp.get("status", {})
        period     = status.get("period", 0)
        clock_disp = status.get("displayClock", "")
        state      = status.get("type", {}).get("name", "")
        is_live    = any(x in state for x in ("InProgress", "Halftime", "EndOfPeriod")) or "progress" in state.lower() or "halftime" in state.lower()
        is_final   = "Final" in state or "final" in state.lower()
        state_label = "Halftime" if "Halftime" in state else \
                      f"Q{period} {clock_disp}" if is_live else \
                      "Final" if is_final else "Scheduled"

        # ── Athlete headshot map: athlete_id → {name, headshot, jersey} ────────
        athlete_map: dict[str, dict] = {}
        boxscore_raw = d.get("boxscore", {})
        for team_obj in boxscore_raw.get("players", []):
            team_id_from_box = team_obj.get("team", {}).get("id", "")
            for stats_obj in team_obj.get("statistics", []):
                for ath in stats_obj.get("athletes", []):
                    a   = ath.get("athlete", {})
                    aid = str(a.get("id", ""))
                    if aid:
                        athlete_map[aid] = {
                            "name":     a.get("displayName", ""),
                            "headshot": a.get("headshot", {}).get("href", ""),
                            "jersey":   a.get("jersey", ""),
                            "team_id":  team_id_from_box,
                        }

        # ── Last 25 plays ────────────────────────────────────────────────────
        all_plays = d.get("plays", [])
        # Build team_id → abbr map
        team_id_map: dict[str, str] = {}
        for side, t in teams_info.items():
            team_id_map[t["id"]] = t["abbr"]

        plays_out = []
        for p in reversed(all_plays[-40:]):   # most recent first, more for animation detection
            team_id  = p.get("team", {}).get("id", "")
            team_abbr = team_id_map.get(team_id, "")
            is_scoring  = p.get("scoringPlay", False)
            is_shooting = p.get("shootingPlay", False)
            coord       = p.get("coordinate", {})
            cx = coord.get("x"); cy_val = coord.get("y")
            # Filter out integer-overflow sentinel values
            valid_coord = (cx is not None and cy_val is not None
                           and abs(cx) < 600 and abs(cy_val) < 600)
            primary_aid = str((p.get("participants") or [{}])[0].get("athlete", {}).get("id", ""))
            ath_info    = athlete_map.get(primary_aid, {})
            plays_out.append({
                "text":           p.get("text", ""),
                "short_text":     p.get("shortDescription", p.get("text", "")),
                "away_score":     p.get("awayScore", 0),
                "home_score":     p.get("homeScore", 0),
                "period":         p.get("period", {}).get("number", period),
                "clock":          p.get("clock", {}).get("displayValue", ""),
                "is_scoring":     is_scoring,
                "is_shooting":    is_shooting,
                "score_value":    p.get("scoreValue", 0),
                "team_abbr":      team_abbr,
                "team_id":        team_id,
                "type":           p.get("type", {}).get("text", ""),
                "wallclock":      p.get("wallclock", ""),
                "sequence_number": p.get("sequenceNumber", "0"),
                # Shot coordinates (None if invalid/unavailable)
                "x":              cx   if valid_coord else None,
                "y":              cy_val if valid_coord else None,
                # Primary athlete
                "headshot":       ath_info.get("headshot", ""),
                "athlete_name":   ath_info.get("name", ""),
                "athlete_id":     primary_aid,
            })

        # ── Win probability (latest) ─────────────────────────────────────────
        wp_data = d.get("winprobability", [])
        win_prob = None
        if wp_data:
            latest_wp = wp_data[-1]
            win_prob = {
                "home_pct": round(latest_wp.get("homeWinPercentage", 0.5) * 100, 1),
                "away_pct": round((1 - latest_wp.get("homeWinPercentage", 0.5)) * 100, 1),
            }

        # ── Team game stats (totals) + on-court players ──────────────────────
        boxscore = d.get("boxscore", {})
        team_stats_out: dict[str, dict] = {}
        for team_obj in boxscore.get("teams", []):
            t_info   = team_obj.get("team", {})
            abbr     = t_info.get("abbreviation", "")
            stats    = team_obj.get("statistics", [])
            stat_map: dict[str, str] = {}
            for s in stats:
                stat_map[s.get("label", "")] = s.get("displayValue", "")
            team_stats_out[abbr] = stat_map

        # ── On-court players (active, not DNP) ───────────────────────────────
        on_court: dict[str, list] = {}   # team_abbr → list of player dicts
        for team_obj in boxscore.get("players", []):
            team_abbr = team_obj.get("team", {}).get("abbreviation", "")
            team_color = team_obj.get("team", {}).get("color", "1a2a4a")
            team_id_box = team_obj.get("team", {}).get("id", "")
            players_list = []
            for stats_obj in team_obj.get("statistics", []):
                labels = stats_obj.get("labels", [])
                for ath in stats_obj.get("athletes", []):
                    if not ath.get("active") or ath.get("didNotPlay"):
                        continue
                    a        = ath.get("athlete", {})
                    raw      = ath.get("stats", [])
                    stat_map2 = dict(zip(labels, raw))
                    players_list.append({
                        "id":       a.get("id", ""),
                        "name":     a.get("displayName", ""),
                        "short":    a.get("shortName", a.get("displayName", "")),
                        "jersey":   a.get("jersey", ""),
                        "headshot": a.get("headshot", {}).get("href", ""),
                        "starter":  ath.get("starter", False),
                        "pts":      stat_map2.get("PTS", "0"),
                        "reb":      stat_map2.get("REB", "0"),
                        "ast":      stat_map2.get("AST", "0"),
                        "min":      stat_map2.get("MIN", "0"),
                        "team_id":  team_id_box,
                        "color":    team_color,
                    })
            on_court[team_abbr] = players_list

        # ── Shot chart data ───────────────────────────────────────────────────
        shots_out = []
        for p in all_plays:
            if not p.get("shootingPlay"):
                continue
            coord = p.get("coordinate", {})
            x = coord.get("x")
            y = coord.get("y")
            # Filter out overflow/invalid coords
            if x is None or y is None or abs(x) > 600 or abs(y) > 600:
                continue
            team_id   = p.get("team", {}).get("id", "")
            team_abbr = team_id_map.get(team_id, "")
            shots_out.append({
                "x":         x,
                "y":         y,
                "made":      p.get("scoringPlay", False),
                "pts":       p.get("scoreValue", 0),
                "text":      p.get("shortDescription", p.get("text", ""))[:60],
                "team_abbr": team_abbr,
                "team_id":   team_id,
                "period":    p.get("period", {}).get("number", 0),
            })

        # ── Possession inference (best effort from latest team-attributed play) ──
        possession = {
            "team_id": "",
            "team_abbr": "",
            "side": "",
            "source": "",
            "sequence_number": 0,
        }
        if is_live and all_plays:
            home_id = teams_info.get("home", {}).get("id", "")
            away_id = teams_info.get("away", {}).get("id", "")
            for p in reversed(all_plays):
                team_id = str(p.get("team", {}).get("id", "") or "")
                if not team_id:
                    continue
                side = "home" if team_id == home_id else "away" if team_id == away_id else ""
                possession = {
                    "team_id": team_id,
                    "team_abbr": team_id_map.get(team_id, ""),
                    "side": side,
                    "source": p.get("shortDescription", p.get("text", ""))[:80],
                    "sequence_number": int(p.get("sequenceNumber", 0) or 0),
                }
                break

        result = {
            "event_id":    event_id,
            "home":        teams_info.get("home", {}),
            "away":        teams_info.get("away", {}),
            "state":       state,
            "state_label": state_label,
            "period":      period,
            "clock":       clock_disp,
            "linescore":   linescore,
            "is_live":     is_live,
            "is_final":    is_final,
            "plays":          plays_out,
            "win_prob":       win_prob,
            "team_stats":     team_stats_out,
            "shots":          shots_out,
            "possession":     possession,
            "athletes":       athlete_map,
            "on_court":       on_court,
            "last_sequence":  int(all_plays[-1].get("sequenceNumber", 0)) if all_plays else 0,
            "total_plays":    len(all_plays),
        }
        _GAME_FEED_CACHE[event_id] = (result, now)
        return result

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/props/nba/{event_id}")
def nba_props_event(event_id: str, home_team: str = "", away_team: str = ""):
    """Fetch player props for a specific NBA event ID."""
    try:
        from sports_model.live_odds import fetch_nba_player_props
        props = fetch_nba_player_props(event_id, home_team, away_team)
        return {"event_id": event_id, "props": props, "count": len(props)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Soccer Alternate Markets (BTTS, Draw No Bet, Goal Scorers)
# ---------------------------------------------------------------------------

# Map our internal league name → The Odds API sport key
_LEAGUE_TO_SPORT_KEY = {
    "epl":          "soccer_epl",
    "premier league": "soccer_epl",
    "bundesliga":   "soccer_germany_bundesliga",
    "laliga":       "soccer_spain_la_liga",
    "liga mx":      "soccer_mexico_ligamx",
    "ucl":          "soccer_uefa_champs_league",
    "champions league": "soccer_uefa_champs_league",
    "europa league": "soccer_uefa_europa_league",
}


@app.get("/api/odds/soccer-alt/{sport_key}/{event_id}")
def soccer_alt_markets(sport_key: str, event_id: str, home_team: str = "", away_team: str = ""):
    """
    Fetch alternate soccer markets for a specific event:
    BTTS, Draw No Bet, player goal scorers.
    sport_key: one of soccer_epl, soccer_uefa_champs_league, etc.
    """
    try:
        from sports_model.live_odds import fetch_soccer_alt_markets
        data = fetch_soccer_alt_markets(sport_key, event_id, home_team, away_team)
        return {"event_id": event_id, "sport_key": sport_key, **data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/odds/soccer-events/{sport_key}")
def soccer_events_list(sport_key: str):
    """List upcoming soccer events with their IDs for a given sport key."""
    try:
        from sports_model.live_odds import get_soccer_event_ids
        return {"sport_key": sport_key, "events": get_soccer_event_ids(sport_key)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Fast schedule endpoint — raw ESPN data only, no odds, no ML scoring
# Used by the Bet Tracker sportsbook view for instant game list
# ---------------------------------------------------------------------------

@app.get("/api/schedule/games")
def schedule_games_fast(days: int = 3):
    """
    Raw upcoming games with no odds enrichment and no ML scoring.
    Cached for 5 minutes so the sportsbook view loads instantly on repeat visits.
    Odds are merged client-side via /api/odds/live.
    """
    cache_key = f"schedule_games_{days}"
    now = _time_module.time()
    cached = _CACHE.get(cache_key)
    if cached and (now - cached["ts"]) < _SCHEDULE_TTL:
        return {**cached["data"], "cached": True}
    try:
        from sports_model.espn_ingest import fetch_upcoming_schedule
        days = min(int(days), 7)
        df = fetch_upcoming_schedule(days_ahead=days, leagues=None, include_mlb=True)
        if df.empty:
            result = {"total": 0, "games": []}
            _CACHE[cache_key] = {"ts": now, "data": result}
            return {**result, "cached": False}
        games = _df_to_records(df)
        FINISHED = {'STATUS_FINAL','STATUS_FULL_TIME','STATUS_FINAL_AET','STATUS_FINAL_PEN'}
        games = [g for g in games if g.get('status') not in FINISHED]
        result = {"total": len(games), "games": games}
        _CACHE[cache_key] = {"ts": now, "data": result}
        return {**result, "cached": False}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Upcoming Schedule (next N days, all leagues, with ML scores + live odds)
# ---------------------------------------------------------------------------

@app.get("/api/schedule")
def upcoming_schedule(
    days: int = 7,
    league: str | None = None,
    sport: str | None = None,
    with_scores: bool = True,
):
    """
    Return upcoming scheduled games for the next `days` days across all leagues.

    Optionally scores each game with the ML model (edge, model_prob, tier)
    and enriches with live FanDuel/DraftKings odds (moneyline, spread, totals).

    Query params:
      days       — how many days ahead to look (default 7, max 14)
      league     — filter by league display name e.g. 'NBA', 'EPL', 'Bundesliga'
      sport      — filter by sport: 'soccer', 'nba', 'mlb'
      with_scores — if true, run ML model on each game (default true)
    """
    try:
        from sports_model.espn_ingest import fetch_upcoming_schedule, ESPN_LEAGUES
        from sports_model.live_odds import build_odds_lookup, enrich_game_with_odds, SPORT_KEYS
        from sports_model.recommendations import (
            _load_hist_and_standings, _build_feature_row, _load_model,
            _get_sport, _sport_features, _implied_prob, _confidence_tier, MIN_EDGE,
        )
        import pandas as pd_inner

        days = min(int(days), 14)  # cap at 14 days

        # Determine which ESPN leagues to fetch
        if league:
            slug_map = {v["display"].lower(): k for k, v in ESPN_LEAGUES.items()}
            slug = slug_map.get(league.lower())
            leagues_to_fetch = [slug] if slug else None
        else:
            leagues_to_fetch = None

        df = fetch_upcoming_schedule(
            days_ahead=days,
            leagues=leagues_to_fetch,
            include_mlb=(sport != "soccer"),
        )

        if df.empty:
            return {"total": 0, "days": days, "games": []}

        games = _df_to_records(df)

        # Filter by sport if specified
        if sport:
            sport_lower = sport.lower()
            games = [
                g for g in games
                if (sport_lower == "nba" and g.get("league") == "NBA")
                or (sport_lower == "mlb" and g.get("league") == "MLB")
                or (sport_lower == "soccer" and g.get("league") not in ("NBA", "MLB"))
            ]

        # Build live odds lookups (one per sport, cached 15 min)
        odds_lookups: dict[str, dict] = {}
        for sp in ["soccer", "nba", "mlb"]:
            try:
                odds_lookups[sp] = build_odds_lookup(sp)
            except Exception:
                odds_lookups[sp] = {}

        # Enrich each game with live odds
        enriched: list[dict] = []
        for g in games:
            sp = _get_sport(g)
            g = enrich_game_with_odds(g, odds_lookups.get(sp, {}))
            enriched.append(g)

        # Score with ML model if requested
        if with_scores:
            hist, standings_lookup = _load_hist_and_standings()
            for g in enriched:
                sp = _get_sport(g)
                model = _load_model(sp)
                if model is None:
                    g["model_prob"] = None
                    g["edge"] = None
                    g["tier"] = None
                    continue
                try:
                    feat_row = _build_feature_row(g, hist, standings_lookup, sp)
                    features = _sport_features(sp)
                    X = pd_inner.DataFrame([{f: feat_row.get(f, 0.0) for f in features}])
                    prob_home = float(model.predict_proba(X)[0][1])
                    prob_away = 1.0 - prob_home
                    home_odds = float(g.get("home_odds") or 1.909)
                    away_odds = float(g.get("away_odds") or 1.909)
                    if home_odds <= 1.0: home_odds = 1.909
                    if away_odds <= 1.0: away_odds = 1.909
                    imp_home = _implied_prob(home_odds)
                    imp_away = _implied_prob(away_odds)
                    edge_home = prob_home - imp_home
                    edge_away = prob_away - imp_away
                    best_edge = max(edge_home, edge_away)
                    bet_side = "home" if edge_home >= edge_away else "away"
                    g["model_prob_home"]  = round(prob_home, 4)
                    g["model_prob_away"]  = round(prob_away, 4)
                    g["edge_home"]        = round(edge_home, 4)
                    g["edge_away"]        = round(edge_away, 4)
                    g["best_edge"]        = round(best_edge, 4)
                    g["bet_side"]         = bet_side
                    g["bet_team"]         = g["home_team"] if bet_side == "home" else g["away_team"]
                    g["tier"]             = _confidence_tier(best_edge) if best_edge >= MIN_EDGE else None
                    g["has_edge"]         = best_edge >= MIN_EDGE
                except Exception:
                    g["model_prob_home"] = None
                    g["edge_home"] = None
                    g["tier"] = None
                    g["has_edge"] = False

        # Group by date for convenience
        by_date: dict[str, list] = {}
        for g in enriched:
            raw_date = g.get("date", "")
            day = str(raw_date)[:10] if raw_date else "unknown"
            by_date.setdefault(day, []).append(g)

        return {
            "total":   len(enriched),
            "days":    days,
            "games":   enriched,
            "by_date": {d: games for d, games in sorted(by_date.items())},
        }

    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Live Odds (The Odds API)
# ---------------------------------------------------------------------------

@app.get("/api/odds/live")
def odds_live(sport: str | None = None):
    """
    Return live h2h odds from The Odds API for all sports (or a specific sport).

    sport: optional filter — 'soccer', 'nba', or 'mlb' (default: all three)
    """
    try:
        from sports_model.live_odds import build_odds_lookup, SPORT_KEYS
        sports = [sport] if sport and sport in SPORT_KEYS else list(SPORT_KEYS.keys())
        all_games: list[dict] = []
        for sp in sports:
            lookup = build_odds_lookup(sp)
            for (home_norm, away_norm), v in lookup.items():
                all_games.append({
                    "sport":             sp,
                    "home_team":         v.get("home_team"),
                    "away_team":         v.get("away_team"),
                    "commence_time":     v.get("commence_time"),
                    # Moneyline
                    "home_odds":         v.get("home_odds"),
                    "away_odds":         v.get("away_odds"),
                    "draw_odds":         v.get("draw_odds"),
                    "home_bk":           v.get("home_bk"),
                    "away_bk":           v.get("away_bk"),
                    "draw_bk":           v.get("draw_bk"),
                    "home_fanduel":      v.get("home_fanduel"),
                    "away_fanduel":      v.get("away_fanduel"),
                    "draw_fanduel":      v.get("draw_fanduel"),
                    "home_draftkings":   v.get("home_draftkings"),
                    "away_draftkings":   v.get("away_draftkings"),
                    "draw_draftkings":   v.get("draw_draftkings"),
                    # Spread
                    "home_spread":       v.get("home_spread"),
                    "away_spread":       v.get("away_spread"),
                    "home_spread_odds":  v.get("home_spread_odds"),
                    "away_spread_odds":  v.get("away_spread_odds"),
                    "spread_bk":         v.get("spread_bk"),
                    # Totals
                    "total_line":        v.get("total_line"),
                    "over_odds":         v.get("over_odds"),
                    "under_odds":        v.get("under_odds"),
                    "totals_bk":         v.get("totals_bk"),
                })
        # Sort by commence_time
        all_games.sort(key=lambda g: g.get("commence_time") or "")
        return {"total": len(all_games), "games": all_games}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/odds/movement")
def odds_movement(hours: int = 24):
    """
    Return odds movement data for all games that have 2+ snapshots
    within the last `hours` hours. Shows open vs current odds and delta.
    """
    try:
        from sports_model.live_odds import get_odds_movement
        return {"games": get_odds_movement(hours=hours)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Live Bet Tracker
# ---------------------------------------------------------------------------

class BetIn(BaseModel):
    date: str
    league: str = ""
    sport: str = ""
    home_team: str = ""
    away_team: str = ""
    bet_side: str = ""
    bet_team: str = ""
    bet_type: str = "moneyline"
    stake: float
    odds: float
    model_prob: Optional[float] = None
    edge: Optional[float] = None
    notes: str = ""


class SettleIn(BaseModel):
    result: str   # 'won' | 'lost' | 'void'


class ParlayLegIn(BaseModel):
    league: str = ""
    sport: str = ""
    home_team: str = ""
    away_team: str = ""
    bet_side: str = ""
    bet_team: str = ""
    bet_type: str = "moneyline"
    odds: float


class ParlayIn(BaseModel):
    date: str
    stake: float
    legs: list[ParlayLegIn]
    notes: str = ""


class ParlaySettleIn(BaseModel):
    result: str   # 'won' | 'lost' | 'void'


# ---------------------------------------------------------------------------
# Straight bets
# ---------------------------------------------------------------------------

@app.get("/api/tracker/summary")
def tracker_summary():
    from sports_model.tracker import tracker_summary as _summary
    return _summary()


@app.get("/api/tracker/bets")
def tracker_bets(limit: int = 200, offset: int = 0,
                 sport: Optional[str] = None, result: Optional[str] = None):
    from sports_model.tracker import list_bets
    bets = list_bets(limit=limit, offset=offset, sport=sport, result=result)
    return {"total": len(bets), "bets": bets}


@app.get("/api/tracker/equity")
def tracker_equity():
    from sports_model.tracker import equity_curve
    return equity_curve()


@app.post("/api/tracker/bets", status_code=201)
def tracker_add_bet(payload: BetIn):
    from sports_model.tracker import add_bet
    try:
        bet = add_bet(**payload.model_dump())
        return bet
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.patch("/api/tracker/bets/{bet_id}/settle")
def tracker_settle(bet_id: int, payload: SettleIn):
    if payload.result not in ("won", "lost", "void"):
        raise HTTPException(status_code=400, detail="result must be 'won', 'lost', or 'void'")
    from sports_model.tracker import settle_bet
    try:
        return settle_bet(bet_id, payload.result)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/tracker/bets/{bet_id}", status_code=204)
def tracker_delete(bet_id: int):
    from sports_model.tracker import delete_bet
    if not delete_bet(bet_id):
        raise HTTPException(status_code=404, detail=f"Bet {bet_id} not found")


# ---------------------------------------------------------------------------
# Parlays
# ---------------------------------------------------------------------------

@app.get("/api/tracker/parlays")
def tracker_list_parlays(limit: int = 100, offset: int = 0, result: Optional[str] = None):
    from sports_model.tracker import list_parlays
    parlays = list_parlays(limit=limit, offset=offset, result=result)
    return {"total": len(parlays), "parlays": parlays}


@app.get("/api/tracker/parlays/{parlay_id}")
def tracker_get_parlay(parlay_id: int):
    from sports_model.tracker import get_parlay
    try:
        return get_parlay(parlay_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/tracker/parlays", status_code=201)
def tracker_add_parlay(payload: ParlayIn):
    from sports_model.tracker import add_parlay
    try:
        legs = [leg.model_dump() for leg in payload.legs]
        return add_parlay(
            date=payload.date,
            stake=payload.stake,
            legs=legs,
            notes=payload.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.patch("/api/tracker/parlays/{parlay_id}/settle")
def tracker_settle_parlay(parlay_id: int, payload: ParlaySettleIn):
    if payload.result not in ("won", "lost", "void"):
        raise HTTPException(status_code=400, detail="result must be 'won', 'lost', or 'void'")
    from sports_model.tracker import settle_parlay
    try:
        return settle_parlay(parlay_id, payload.result)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/tracker/parlays/{parlay_id}", status_code=204)
def tracker_delete_parlay(parlay_id: int):
    from sports_model.tracker import delete_parlay
    if not delete_parlay(parlay_id):
        raise HTTPException(status_code=404, detail=f"Parlay {parlay_id} not found")


@app.post("/api/tracker/parlays/resolve")
def tracker_resolve_parlays(target_date: Optional[str] = None):
    """Auto-resolve pending parlays for a date from ESPN scores."""
    from sports_model.tracker import auto_resolve_parlays
    from datetime import date as date_type, timedelta
    if not target_date:
        target_date = (date_type.today() - timedelta(days=1)).isoformat()
    try:
        return auto_resolve_parlays(target_date)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Head-to-Head history
# ---------------------------------------------------------------------------

@app.get("/api/h2h")
def h2h(home: str, away: str, n: int = 10):
    """Return last N head-to-head results between two teams from historical data."""
    try:
        hist_path = DATA_DIR / "historical_games.csv"
        if not hist_path.exists():
            return {"matches": [], "home": home, "away": away}
        df = pd.read_csv(hist_path)
        mask = (
            ((df["home_team"] == home) & (df["away_team"] == away)) |
            ((df["home_team"] == away) & (df["away_team"] == home))
        )
        h2h_df = df[mask].sort_values("date", ascending=False).head(n)
        h2h_df = h2h_df.astype(object).where(pd.notnull(h2h_df.astype(object)), None)
        records = h2h_df[["date", "league", "home_team", "away_team",
                           "home_score", "away_score"]].to_dict(orient="records")
        # Add result label from perspective of `home` team
        for r in records:
            hs, as_ = r.get("home_score"), r.get("away_score")
            if hs is None or as_ is None:
                r["result"] = "?"
            elif r["home_team"] == home:
                r["result"] = "W" if hs > as_ else ("D" if hs == as_ else "L")
            else:
                r["result"] = "W" if as_ > hs else ("D" if hs == as_ else "L")
        return {"home": home, "away": away, "matches": records}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# News sentiment for a team (live from NewsData.io)
# ---------------------------------------------------------------------------

@app.get("/api/news/{team}")
def team_news(team: str, days: int = 3):
    """Fetch recent news headlines + sentiment for a team via NewsData.io."""
    try:
        from sports_model.data_sources import fetch_news_sentiment
        articles = fetch_news_sentiment(team, days=days)
        return {"team": team, "articles": articles}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Prediction W/R History
# ---------------------------------------------------------------------------

@app.get("/api/predictions")
def predictions_list(
    limit: int = 200, offset: int = 0,
    sport: Optional[str] = None,
    tier: Optional[str] = None,
    result: Optional[str] = None,
):
    """List logged AI predictions with optional filters."""
    from sports_model.prediction_log import list_predictions
    rows = list_predictions(limit=limit, offset=offset, sport=sport, tier=tier, result=result)
    return {"total": len(rows), "predictions": rows}


@app.get("/api/predictions/stats")
def predictions_stats():
    """W/R stats overall, by sport, and by tier."""
    from sports_model.prediction_log import prediction_stats
    return prediction_stats()


@app.get("/api/predictions/rolling")
def predictions_rolling(window: int = 7):
    """Daily W/R and rolling hit rate for the last 90 days."""
    from sports_model.prediction_log import rolling_accuracy
    return rolling_accuracy(window=window)


@app.get("/api/predictions/calibration")
def predictions_calibration():
    """Calibration data: model probability bins vs actual hit rate."""
    from sports_model.prediction_log import calibration_data
    return calibration_data()


@app.post("/api/predictions/resolve")
def predictions_resolve(target_date: Optional[str] = None):
    """
    Fetch ESPN results for target_date (default: yesterday) and
    auto-resolve all pending predictions for that date.
    """
    try:
        from sports_model.prediction_log import resolve_date
        summary = resolve_date(target_date)
        return summary
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/predictions/log")
def predictions_log_today(top_n: int = 8):
    """Manually trigger today's picks to be logged (normally auto-logged by /api/recommendations)."""
    try:
        from sports_model.recommendations import score_todays_games
        from sports_model.prediction_log import log_picks
        from datetime import date as date_type
        picks = score_todays_games(top_n=top_n)
        count = log_picks(picks, pick_date=date_type.today().isoformat())
        return {"logged": count, "picks": picks}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# AI Chat — ask Gemini about games, parlays, betting strategy
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str   # 'user' | 'assistant'
    content: str

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    include_context: bool = True  # inject today's picks + live odds as context


class PropFactorExplainIn(BaseModel):
    player: str
    market_label: str
    call: str
    line: float | None = None
    confidence: float | None = None
    context: dict = {}
    force_regen: bool = False


class PropParlayExplainLeg(BaseModel):
    player: str
    market_label: str
    call: str
    line: float | None = None
    confidence: float | None = None
    tier: str | None = None
    home_team: str | None = None
    away_team: str | None = None


class PropParlayExplainIn(BaseModel):
    legs: list[PropParlayExplainLeg]


_FACTOR_EXPLAIN_CACHE: dict[str, tuple[dict, float]] = {}
_FACTOR_EXPLAIN_TTL = 86400  # 24h


@app.post("/api/props/nba/factor-explanations")
def prop_factor_explanations(payload: PropFactorExplainIn):
    """Generate plain-language factor hover text (EN + ES) with Gemini."""
    import os
    from dotenv import load_dotenv
    load_dotenv()

    base_fallback_en = {
        "momentum": "Shows if the player is trending up or down recently.",
        "usage": "Shows how involved the player is in offense and shot creation.",
        "matchup": "Shows if this opponent is easy or tough for this player type.",
        "pace": "Shows game speed: faster pace usually means more stat chances.",
        "minutes": "Shows whether recent minutes are rising or falling.",
        "rest": "Shows fatigue risk from back-to-backs and schedule load.",
        "starter": "Shows role stability and chance of consistent minutes.",
        "market": "Shows whether books agree on the line or there is uncertainty.",
    }
    base_fallback_es = {
        "momentum": "Muestra si el jugador viene subiendo o bajando recientemente.",
        "usage": "Muestra que tan involucrado esta el jugador en el ataque.",
        "matchup": "Muestra si este rival es facil o dificil para este tipo de jugador.",
        "pace": "Muestra la velocidad del juego: mas ritmo suele dar mas opciones de estadisticas.",
        "minutes": "Muestra si los minutos recientes suben o bajan.",
        "rest": "Muestra riesgo de cansancio por back-to-back y carga semanal.",
        "starter": "Muestra estabilidad de rol y probabilidad de minutos consistentes.",
        "market": "Muestra si las casas coinciden en la linea o hay incertidumbre.",
    }

    # Stable cache key so repeated hover requests don't spend tokens
    cache_payload = {
        "player": payload.player,
        "market_label": payload.market_label,
        "call": payload.call,
        "line": payload.line,
        "confidence": round(float(payload.confidence or 0), 4),
        "context": payload.context or {},
    }
    cache_key = hashlib.sha1(json.dumps(cache_payload, sort_keys=True).encode("utf-8")).hexdigest()
    now = _time_module.time()
    cached = _FACTOR_EXPLAIN_CACHE.get(cache_key)
    if (not payload.force_regen) and cached and now - cached[1] < _FACTOR_EXPLAIN_TTL:
        return cached[0]

    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL   = "models/gemini-3.1-pro-preview"
    if not GEMINI_API_KEY:
        out = {
            "source": "fallback",
            "en": base_fallback_en,
            "es": base_fallback_es,
        }
        return out


    ctx = payload.context or {}
    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        prompt = f"""
You are writing micro-explanations for a sports props UI tooltip.
Goal: explain each factor in plain language for non-bettors.

Player: {payload.player}
Market: {payload.market_label}
Call: {payload.call} {payload.line}
Confidence: {payload.confidence}
Context values:
{json.dumps(ctx, ensure_ascii=False)}

Return ONLY valid minified JSON with this exact shape:
{{
  "en": {{
    "momentum": "...",
    "usage": "...",
    "matchup": "...",
    "pace": "...",
    "minutes": "...",
    "rest": "...",
    "starter": "...",
    "market": "..."
  }},
  "es": {{
    "momentum": "...",
    "usage": "...",
    "matchup": "...",
    "pace": "...",
    "minutes": "...",
    "rest": "...",
    "starter": "...",
    "market": "..."
  }}
}}

Rules:
- One sentence per factor, max 22 words.
- Explain "why" using the provided numbers in a natural way.
- Use everyday language and avoid betting jargon.
- Mention at least one specific numeric clue when available (minutes, rest days, confidence, line gap, etc.).
- No jargon unless immediately explained.
- Do not include markdown.
"""
        resp = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        text = (resp.text or "").strip()
        parsed = None
        try:
            parsed = json.loads(text)
        except Exception:
            cleaned = text.replace("```json", "").replace("```", "").strip()
            try:
                parsed = json.loads(cleaned)
            except Exception:
                l = cleaned.find("{")
                r = cleaned.rfind("}")
                if l != -1 and r != -1 and r > l:
                    parsed = json.loads(cleaned[l:r + 1])
                else:
                    raise
        en = parsed.get("en", {}) if isinstance(parsed, dict) else {}
        es = parsed.get("es", {}) if isinstance(parsed, dict) else {}
        out = {
            "source": "gemini",
            "en": {**base_fallback_en, **en},
            "es": {**base_fallback_es, **es},
        }
        _FACTOR_EXPLAIN_CACHE[cache_key] = (out, now)
        return out
    except Exception:
        out = {
            "source": "fallback",
            "en": base_fallback_en,
            "es": base_fallback_es,
        }
        # Don't long-cache fallback responses; allow quick recovery on next attempt
        return out


@app.post("/api/props/nba/parlay-explain")
def prop_parlay_explain(payload: PropParlayExplainIn):
    """Generate AI explanation for why a multi-leg prop parlay is considered solid."""
    import os
    from dotenv import load_dotenv
    load_dotenv()

    legs = payload.legs or []
    if not legs:
        return {
            "source": "fallback",
            "en": {"summary": "No legs provided.", "bullets": [], "risks": []},
            "es": {"summary": "No se enviaron selecciones.", "bullets": [], "risks": []},
        }

    avg_conf = sum(float(l.confidence or 0.5) for l in legs) / max(1, len(legs))
    strong_n = sum(1 for l in legs if (l.tier or "") == "Strong")
    fallback = {
        "source": "fallback",
        "en": {
            "summary": f"This parlay is built from {len(legs)} legs with average confidence {round(avg_conf*100)}% and {strong_n} strong picks.",
            "bullets": [
                "The legs are selected from higher-confidence props rather than random picks.",
                "They are split across multiple games to reduce single-game volatility.",
                "Player form and role stability are prioritized in selection.",
            ],
            "risks": [
                "Player props can still miss due to minutes, foul trouble, or game script changes.",
                "Eight-leg parlays are high variance even with good selections.",
            ],
        },
        "es": {
            "summary": f"Este parlay se arma con {len(legs)} selecciones, confianza promedio de {round(avg_conf*100)}% y {strong_n} picks fuertes.",
            "bullets": [
                "Las selecciones salen de props con mayor confianza, no al azar.",
                "Se distribuyen en varios partidos para reducir dependencia de un solo juego.",
                "Se prioriza forma reciente y estabilidad de rol del jugador.",
            ],
            "risks": [
                "Los props pueden fallar por minutos, faltas o cambios de guion del juego.",
                "Un parlay de 8 piernas sigue siendo de alta varianza.",
            ],
        },
    }

    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL   = "models/gemini-3.1-pro-preview"
    if not GEMINI_API_KEY:
        return fallback

    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        legs_payload = [l.model_dump() for l in legs]
        prompt = f"""
You are a sports props analyst explaining why a selected parlay is considered relatively solid.
Use plain language for non-bettors.

Parlay legs:
{json.dumps(legs_payload, ensure_ascii=False)}

Return ONLY valid minified JSON:
{{
  "en": {{"summary":"...","bullets":["...","...","..."],"risks":["...","..."]}},
  "es": {{"summary":"...","bullets":["...","...","..."],"risks":["...","..."]}}
}}

Rules:
- Clear and practical language.
- Mention why these are stronger than average picks.
- Mention real risks honestly.
- No markdown.
"""
        resp = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        txt = (resp.text or "").strip()
        try:
            parsed = json.loads(txt)
        except Exception:
            cleaned = txt.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(cleaned[cleaned.find("{"): cleaned.rfind("}") + 1])

        en = (parsed or {}).get("en", {}) if isinstance(parsed, dict) else {}
        es = (parsed or {}).get("es", {}) if isinstance(parsed, dict) else {}
        return {
            "source": "gemini",
            "en": {
                "summary": en.get("summary") or fallback["en"]["summary"],
                "bullets": en.get("bullets") or fallback["en"]["bullets"],
                "risks": en.get("risks") or fallback["en"]["risks"],
            },
            "es": {
                "summary": es.get("summary") or fallback["es"]["summary"],
                "bullets": es.get("bullets") or fallback["es"]["bullets"],
                "risks": es.get("risks") or fallback["es"]["risks"],
            },
        }
    except Exception:
        return fallback


@app.post("/api/chat")
def ai_chat(req: ChatRequest):
    """
    Send a message to Gemini with optional sports betting context injected.

    The assistant has access to:
    - Today's AI picks (model edges, odds, tiers)
    - Live upcoming odds (FanDuel / DraftKings h2h, spreads, totals)
    - Tomorrow's top picks if the user asks about tomorrow

    Returns {reply: str, sources: list[str]}
    """
    import os
    from datetime import date as date_type
    from dotenv import load_dotenv
    load_dotenv()

    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL   = "models/gemini-3.1-pro-preview"  # Most current Gemini model as of this project

    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="Gemini API key not configured.")

    # ── Build context block ──
    context_lines: list[str] = []
    sources: list[str] = []
    today = date_type.today().isoformat()

    if req.include_context:
        # Today's picks
        try:
            from sports_model.recommendations import score_todays_games
            picks = score_todays_games(top_n=10)
            if picks:
                context_lines.append(f"TODAY'S AI PICKS ({today}):")
                for p in picks:
                    spread_info = ""
                    if p.get("home_spread") is not None:
                        spread_info = f" | Spread: {p['home_team']} {p['home_spread']:+.1f} ({p.get('home_spread_odds','?')})"
                    total_info = ""
                    if p.get("total_line") is not None:
                        total_info = f" | Total: {p['total_line']} (O {p.get('over_odds','?')} / U {p.get('under_odds','?')})"
                    context_lines.append(
                        f"  - {p['bet_team']} ({p['bet_side'].upper()}) vs "
                        f"{p['away_team'] if p['bet_side']=='home' else p['home_team']} "
                        f"| {p['league']} | Edge: {p['edge']*100:.1f}% | Odds: {p['odds']} "
                        f"| Tier: {p['tier']} | Model: {p['model_prob']*100:.1f}%"
                        f"{spread_info}{total_info}"
                    )
                sources.append("today_picks")
        except Exception as exc:
            context_lines.append(f"(Could not load today's picks: {exc})")

        # Live odds snapshot (top 15 games)
        try:
            from sports_model.live_odds import build_odds_lookup, SPORT_KEYS
            context_lines.append("\nUPCOMING LIVE ODDS (FanDuel / DraftKings):")
            count = 0
            for sp in SPORT_KEYS:
                lk = build_odds_lookup(sp)
                for (hn, an), v in lk.items():
                    if count >= 15:
                        break
                    spread = f" | Spread: {v['home_spread']:+.1f}" if v.get('home_spread') is not None else ""
                    total  = f" | O/U: {v['total_line']}" if v.get('total_line') is not None else ""
                    context_lines.append(
                        f"  {v['home_team']} vs {v['away_team']} ({sp})"
                        f" | ML: {v.get('home_odds','?')}/{v.get('away_odds','?')}"
                        f"{spread}{total}"
                    )
                    count += 1
                if count >= 15:
                    break
            sources.append("live_odds")
        except Exception as exc:
            context_lines.append(f"(Could not load live odds: {exc})")

        # Upcoming schedule — today, tomorrow, and the day after
        try:
            from datetime import date as _date, timedelta as _td
            from sports_model.espn_ingest import fetch_upcoming_schedule
            sched_df = fetch_upcoming_schedule(days_ahead=3, leagues=None, include_mlb=True)
            if not sched_df.empty:
                # Group by date
                sched_df["_day"] = sched_df["date"].astype(str).str[:10]
                today_str    = _date.today().isoformat()
                tomorrow_str = (_date.today() + _td(days=1)).isoformat()
                day_after    = (_date.today() + _td(days=2)).isoformat()
                label_map    = {
                    today_str:    f"TODAY ({today_str})",
                    tomorrow_str: f"TOMORROW ({tomorrow_str})",
                    day_after:    f"DAY AFTER TOMORROW ({day_after})",
                }
                context_lines.append("\nUPCOMING SCHEDULE (next 3 days):")
                for day_key in sorted(sched_df["_day"].unique()):
                    if day_key not in label_map:
                        continue
                    day_games = sched_df[sched_df["_day"] == day_key]
                    context_lines.append(f"  {label_map[day_key]}:")
                    for _, row in day_games.head(25).iterrows():
                        league = row.get("league", "?")
                        home   = row.get("home_team", "?")
                        away   = row.get("away_team", "?")
                        # Game time — try to extract HH:MM from date string
                        raw_date = str(row.get("date", ""))
                        time_str = ""
                        if "T" in raw_date:
                            time_str = f" @ {raw_date[11:16]} UTC"
                        context_lines.append(f"    - [{league}] {home} vs {away}{time_str}")
                sources.append("schedule")
        except Exception as exc:
            context_lines.append(f"(Could not load schedule: {exc})")

        # Tomorrow's AI picks
        try:
            from sports_model.recommendations import score_tomorrows_games
            tmrw_picks = score_tomorrows_games(top_n=10)
            if tmrw_picks:
                from datetime import date as _d2, timedelta as _td2
                tmrw = (_d2.today() + _td2(days=1)).isoformat()
                context_lines.append(f"\nTOMORROW'S AI PICKS ({tmrw}):")
                for p in tmrw_picks:
                    context_lines.append(
                        f"  - {p['bet_team']} ({p['bet_side'].upper()}) vs "
                        f"{p['away_team'] if p['bet_side']=='home' else p['home_team']} "
                        f"| {p['league']} | Edge: {p['edge']*100:.1f}% | Odds: {p['odds']} "
                        f"| Tier: {p['tier']} | Model: {p['model_prob']*100:.1f}%"
                    )
                sources.append("tomorrow_picks")
        except Exception:
            pass  # tomorrow picks are optional; silently skip if unavailable

    context_block = "\n".join(context_lines)

    # ── Build conversation for Gemini ──
    system_prompt = f"""You are a sharp, knowledgeable sports betting analyst assistant.
Today is {today}.

You have access to real data from our ML prediction system, live bookmaker odds, and the upcoming game schedule.
The context below includes:
- Today's AI model picks with edges and odds
- Tomorrow's AI model picks
- The full schedule for today, tomorrow, and the day after (all leagues: EPL, Bundesliga, LaLiga, NBA, MLB, etc.)
- Live moneyline, spread, and over/under odds from FanDuel / DraftKings

When asked about tomorrow's games, next games, or upcoming matches, use the UPCOMING SCHEDULE section.
When asked about parlays, picks, or strategy, be specific and reference the actual numbers.
Be honest about uncertainty. Never guarantee outcomes. Recommend responsible bankroll sizing (Kelly criterion).
Do not invent statistics that aren't in the provided data.

AVAILABLE CONTEXT DATA:
{context_block if context_block else '(No context loaded)'}

Answer the user's question using the data above where relevant. If they ask about games or odds not in the context, say so clearly."""

    # Build full conversation
    history_text = ""
    for msg in req.history[-6:]:  # last 6 turns to stay within token limits
        role_label = "User" if msg.role == "user" else "Assistant"
        history_text += f"\n{role_label}: {msg.content}"

    full_prompt = f"{system_prompt}\n\nConversation history:{history_text}\n\nUser: {req.message}\nAssistant:"

    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(model=GEMINI_MODEL, contents=full_prompt)
        reply = response.text or "No response generated."
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Gemini error: {exc}")

    return {"reply": reply, "sources": sources}


# ---------------------------------------------------------------------------
# AI Bet Critic — brutal honest analysis of a specific placed bet
# ---------------------------------------------------------------------------

class BetCriticIn(BaseModel):
    bet_id: int | None = None          # optional: link to tracker bet
    bet_team: str
    league: str
    sport: str
    bet_type: str = "moneyline"        # moneyline | total_over | total_under | draw
    odds: float                         # decimal odds at time of bet
    stake: float
    model_prob: float | None = None    # our model's probability for this bet
    edge: float | None = None          # model edge at time of bet
    result: str | None = None          # 'won' | 'lost' | 'void' | None if pending
    pnl: float | None = None
    notes: str = ""


@app.post("/api/critic/bet")
def critic_bet(payload: BetCriticIn):
    """
    Brutal honest AI critique of a single bet.
    Calculates EV, CLV proxy, Kelly sizing and tells you exactly
    whether the bet was good or bad process — regardless of outcome.
    """
    try:
        # Calculate key metrics
        implied = 1.0 / payload.odds if payload.odds > 1 else None
        model_prob = payload.model_prob
        edge = payload.edge or (model_prob - implied if model_prob and implied else None)

        # Kelly fraction
        if model_prob and implied and payload.odds > 1:
            kelly = (model_prob * payload.odds - 1) / (payload.odds - 1)
            kelly_pct = round(kelly * 100, 1)
        else:
            kelly = None
            kelly_pct = None

        # EV
        if model_prob and payload.odds > 1:
            ev = model_prob * (payload.odds - 1) - (1 - model_prob)
            ev_per_unit = round(ev, 4)
        else:
            ev_per_unit = None

        # Build context for Gemini
        result_str = payload.result or "pending"
        pnl_str = f"${payload.pnl:+.2f}" if payload.pnl is not None else "not yet settled"

        prompt = f"""You are a brutally honest sports betting analyst. Your job is to critique this bet with zero sugar-coating.
You must evaluate the PROCESS (was this a good bet based on the numbers?) completely separately from the OUTCOME (did it win?).
A bet can be a good process bet that lost, or a terrible process bet that won. Outcome does not determine quality.

BET DETAILS:
- Selection: {payload.bet_team} ({payload.bet_type}) — {payload.league}
- Odds: {payload.odds} (decimal)  →  implied probability: {round(implied*100,1) if implied else 'unknown'}%
- Stake: ${payload.stake:.2f}
- Model probability: {round(model_prob*100,1) if model_prob else 'not available'}%
- Model edge: {round(edge*100,1) if edge else 'unknown'}%
- Kelly fraction: {kelly_pct}% of bankroll (full Kelly)
- Expected value per $1: {ev_per_unit} (positive = +EV bet)
- Result: {result_str}
- P&L: {pnl_str}
- Notes: {payload.notes or 'none'}

YOUR ANALYSIS MUST:
1. State clearly whether this was a +EV bet or -EV bet based on the model edge
2. Critique the stake sizing vs Kelly criterion — was it over-bet, under-bet, or appropriate?
3. If the result was bad: separate process quality from bad luck
4. If the result was good: warn if it was actually a bad process bet that got lucky
5. Give ONE specific thing to improve next time
6. Be direct. No "great bet!" if the edge was thin. No "bad luck" if it was a negative EV bet.
Keep it under 150 words. Be surgical, not verbose."""

        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        critique = response.text or "Unable to generate critique."

        return {
            "bet_team":     payload.bet_team,
            "odds":         payload.odds,
            "implied_prob": round(implied, 4) if implied else None,
            "model_prob":   model_prob,
            "edge":         round(edge, 4) if edge else None,
            "ev_per_unit":  ev_per_unit,
            "kelly_pct":    kelly_pct,
            "result":       result_str,
            "pnl":          payload.pnl,
            "critique":     critique,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/critic/session")
def critic_session():
    """
    Brutally honest critique of the user's full betting history.
    Identifies patterns: over-betting, chasing, bad league, etc.
    """
    try:
        from sports_model.tracker import list_bets, tracker_summary
        bets = list_bets(limit=100)
        summary = tracker_summary()

        if not bets:
            return {"critique": "No bets recorded yet. Place some bets first."}

        # Build summary stats for Gemini
        settled = [b for b in bets if b.get("result") in ("won", "lost")]
        won_count  = sum(1 for b in settled if b["result"] == "won")
        lost_count = sum(1 for b in settled if b["result"] == "lost")
        hit_rate   = won_count / len(settled) if settled else None
        total_pnl  = sum(b.get("pnl") or 0 for b in settled)
        avg_stake  = sum(b.get("stake") or 0 for b in bets) / len(bets) if bets else 0
        avg_odds   = sum(b.get("odds") or 0 for b in bets) / len(bets) if bets else 0
        avg_edge   = sum(b.get("edge") or 0 for b in bets if b.get("edge")) / max(1, sum(1 for b in bets if b.get("edge")))

        # League breakdown
        league_pnl: dict[str, float] = {}
        for b in settled:
            lg = b.get("league", "Unknown")
            league_pnl[lg] = league_pnl.get(lg, 0) + (b.get("pnl") or 0)
        worst_league = min(league_pnl, key=league_pnl.get) if league_pnl else None
        best_league  = max(league_pnl, key=league_pnl.get) if league_pnl else None

        # Recent last-5 streak
        recent = [b.get("result") for b in settled[-5:]]

        prompt = f"""You are a brutally honest betting performance analyst. Review this bettor's history and give them the unfiltered truth.

BETTING HISTORY SUMMARY:
- Total bets: {len(bets)} ({len(settled)} settled, {len(bets)-len(settled)} pending)
- Win/Loss: {won_count}W / {lost_count}L
- Hit rate: {round(hit_rate*100,1) if hit_rate else 'N/A'}%  (professional baseline: 54-56%)
- Total P&L: ${total_pnl:+.2f}
- Average stake: ${avg_stake:.2f}
- Average odds: {avg_odds:.2f} (decimal)
- Average model edge: {round(avg_edge*100,1)}%
- Best league by P&L: {best_league} (${league_pnl.get(best_league,0):+.2f})
- Worst league by P&L: {worst_league} (${league_pnl.get(worst_league,0):+.2f})
- Last 5 results: {recent}

INSTRUCTIONS:
1. Start with the hard truth about their overall performance — no softening
2. Call out any obvious problems: losing league, stake inconsistency, chasing losses
3. Identify the ONE thing dragging down their results most
4. Give 2 concrete actionable fixes
5. If they're doing well, still find something to improve
6. Max 200 words. Be direct. Data-driven. No praise for mediocre results."""

        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)

        return {
            "summary": {
                "total_bets":   len(bets),
                "won":          won_count,
                "lost":         lost_count,
                "hit_rate":     round(hit_rate, 4) if hit_rate else None,
                "total_pnl":    round(total_pnl, 2),
                "avg_edge":     round(avg_edge, 4),
                "best_league":  best_league,
                "worst_league": worst_league,
            },
            "critique": response.text or "Unable to generate critique.",
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
