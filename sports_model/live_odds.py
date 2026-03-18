"""
Live odds enrichment from The Odds API (free tier).

Fetches real FanDuel + DraftKings h2h odds for all upcoming games
and returns a lookup dict keyed by normalized team pairs.

Free tier: 500 requests/month. We cache results for the session
to avoid burning quota — one fetch per sport key per process lifetime.

Also persists timestamped snapshots to SQLite for odds movement tracking.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from difflib import get_close_matches
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

DB_PATH = Path(os.getenv("DATA_DIR", "data")) / "tracker.db"


@contextmanager
def _db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _init_snapshots_table() -> None:
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS odds_snapshots (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                fetched_at   TEXT NOT NULL,
                sport        TEXT NOT NULL,
                home_team    TEXT NOT NULL,
                away_team    TEXT NOT NULL,
                commence_time TEXT,
                home_odds    REAL,
                away_odds    REAL,
                draw_odds    REAL,
                total_line   REAL,
                over_odds    REAL,
                under_odds   REAL,
                home_spread  REAL,
                away_spread  REAL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_snap_teams
            ON odds_snapshots(home_team, away_team, fetched_at)
        """)

load_dotenv()
logger = logging.getLogger(__name__)

THE_ODDS_API_KEY = os.getenv("THE_ODDS_API_KEY", "")
BASE_URL = "https://api.the-odds-api.com/v4"

# Sport keys for The Odds API
SPORT_KEYS: dict[str, list[str]] = {
    "soccer": [
        "soccer_epl",
        "soccer_germany_bundesliga",
        "soccer_spain_la_liga",
        "soccer_mexico_ligamx",
        "soccer_uefa_champs_league",
        "soccer_uefa_europa_league",
    ],
    "nba": ["basketball_nba"],
    "mlb": ["baseball_mlb"],
}

# Markets to fetch for main picks scoring.
# spreads removed — the ML model doesn't use spread lines, only h2h + totals.
# This saves 1 request per sport key per fetch (33% reduction on soccer = 6 saved calls).
ALL_MARKETS = ["h2h", "totals"]

# Preferred bookmakers in priority order
BOOKMAKERS = ["fanduel", "draftkings", "betmgm", "caesars", "pointsbet"]

# Session-level cache: {cache_key: [event_list]}
_CACHE: dict[str, Any] = {}
_CACHE_TS: dict[str, float] = {}
CACHE_TTL = 1800  # 30 minutes — odds change slowly for pre-match games; was 15 min

# Sport-level lookup cache: {sport: (lookup_dict, timestamp)}
# Caches the full build_odds_lookup result — same 30-min TTL as raw cache
_LOOKUP_CACHE: dict[str, tuple[dict, float]] = {}


def _normalize_team(name: str) -> str:
    """Lowercase + strip common words for fuzzy matching."""
    import re
    name = name.lower().strip()
    for w in [" fc", " cf", " sc", " ac", " united", " city", " utd", " f.c."]:
        name = name.replace(w, "")
    name = re.sub(r"[^a-z0-9 ]", "", name)
    return name.strip()


def _fetch_sport_odds(sport_key: str, markets: list[str] | None = None) -> list[dict]:
    """Fetch h2h + spreads + totals odds for a sport key from The Odds API."""
    if not THE_ODDS_API_KEY:
        return []

    market_str = ",".join(markets or ALL_MARKETS)
    cache_key = f"{sport_key}|{market_str}"
    now = time.time()
    if cache_key in _CACHE and now - _CACHE_TS.get(cache_key, 0) < CACHE_TTL:
        return _CACHE[cache_key]

    try:
        r = requests.get(
            f"{BASE_URL}/sports/{sport_key}/odds/",
            params={
                "apiKey":      THE_ODDS_API_KEY,
                "regions":     "us",
                "markets":     market_str,
                "oddsFormat":  "decimal",
                "bookmakers":  ",".join(BOOKMAKERS),
            },
            timeout=12,
        )
        remaining = r.headers.get("x-requests-remaining", "?")
        logger.info("Odds API %s [%s]: status=%s remaining=%s", sport_key, market_str, r.status_code, remaining)

        if r.status_code == 401:
            logger.warning("Odds API: unauthorized — check key or quota")
            return []
        if r.status_code == 422:
            logger.debug("Odds API: sport key not found %s", sport_key)
            return []
        r.raise_for_status()
        events = r.json()
        _CACHE[cache_key] = events
        _CACHE_TS[cache_key] = now
        return events

    except Exception as exc:
        logger.warning("Odds API fetch failed %s: %s", sport_key, exc)
        return []


def _best_odds(event: dict) -> dict:
    """
    Extract best available odds from bookmakers across h2h, spreads, and totals.
    Returns a rich dict with moneyline, spread, and total markets.
    """
    home = event["home_team"]
    away = event["away_team"]
    result: dict[str, Any] = {
        "home_team":       home,
        "away_team":       away,
        "commence_time":   event.get("commence_time", ""),
        # Moneyline (h2h)
        "home_odds":       None,
        "away_odds":       None,
        "draw_odds":       None,
        "home_bk":         None,
        "away_bk":         None,
        "draw_bk":         None,
        "home_fanduel":    None,
        "away_fanduel":    None,
        "draw_fanduel":    None,
        "home_draftkings": None,
        "away_draftkings": None,
        "draw_draftkings": None,
        # Spread (handicap)
        "home_spread":        None,   # e.g. -5.5
        "away_spread":        None,   # e.g. +5.5
        "home_spread_odds":   None,
        "away_spread_odds":   None,
        "spread_bk":          None,
        # Totals (over/under)
        "total_line":         None,   # e.g. 220.5
        "over_odds":          None,
        "under_odds":         None,
        "totals_bk":          None,
    }

    best_home = 0.0
    best_away = 0.0
    best_draw = 0.0

    for bk in event.get("bookmakers", []):
        bk_key = bk.get("key", "")
        for mkt in bk.get("markets", []):
            mkt_key = mkt.get("key", "")
            outcomes = mkt.get("outcomes", [])

            # ── Moneyline (h2h) — includes draw for soccer ──
            if mkt_key == "h2h":
                prices = {o["name"]: o["price"] for o in outcomes}
                ho = prices.get(home)
                ao = prices.get(away)
                do = prices.get("Draw")
                if ho and ao:
                    if bk_key == "fanduel":
                        result["home_fanduel"] = ho
                        result["away_fanduel"] = ao
                        if do: result["draw_fanduel"] = do
                    if bk_key == "draftkings":
                        result["home_draftkings"] = ho
                        result["away_draftkings"] = ao
                        if do: result["draw_draftkings"] = do
                    if ho > best_home:
                        best_home = ho
                        result["home_odds"] = ho
                        result["home_bk"] = bk_key
                    if ao > best_away:
                        best_away = ao
                        result["away_odds"] = ao
                        result["away_bk"] = bk_key
                if do and do > best_draw:
                    best_draw = do
                    result["draw_odds"] = do
                    result["draw_bk"] = bk_key

            # ── Spread / Handicap ──
            elif mkt_key == "spreads" and result["home_spread"] is None:
                for o in outcomes:
                    pt = o.get("point", 0)
                    if o["name"] == home:
                        result["home_spread"] = pt
                        result["home_spread_odds"] = o.get("price")
                        result["spread_bk"] = bk_key
                    elif o["name"] == away:
                        result["away_spread"] = pt
                        result["away_spread_odds"] = o.get("price")

            # ── Totals (Over/Under) ──
            elif mkt_key == "totals" and result["total_line"] is None:
                for o in outcomes:
                    pt = o.get("point")
                    if o["name"] == "Over":
                        result["total_line"] = pt
                        result["over_odds"] = o.get("price")
                        result["totals_bk"] = bk_key
                    elif o["name"] == "Under":
                        result["under_odds"] = o.get("price")

    return result


def _persist_snapshots(sport: str, events_odds: list[dict]) -> None:
    """Store a timestamped odds snapshot for each game — used for movement tracking."""
    if not events_odds:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        _init_snapshots_table()
        with _db() as conn:
            for v in events_odds:
                conn.execute("""
                    INSERT INTO odds_snapshots
                      (fetched_at, sport, home_team, away_team, commence_time,
                       home_odds, away_odds, draw_odds,
                       total_line, over_odds, under_odds,
                       home_spread, away_spread)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    now, sport,
                    v.get("home_team", ""),
                    v.get("away_team", ""),
                    v.get("commence_time"),
                    v.get("home_odds"),
                    v.get("away_odds"),
                    v.get("draw_odds"),
                    v.get("total_line"),
                    v.get("over_odds"),
                    v.get("under_odds"),
                    v.get("home_spread"),
                    v.get("away_spread"),
                ))
    except Exception as exc:
        logger.warning("Failed to persist odds snapshot: %s", exc)


def build_odds_lookup(sport: str) -> dict[str, dict]:
    """
    Build a lookup dict for a sport:
      {(norm_home, norm_away): odds_dict}

    The full result is cached at the sport level (CACHE_TTL = 30 min) to avoid
    re-fetching 6 soccer keys sequentially on every picks call.
    Also persists a snapshot to SQLite only on fresh API fetches.
    """
    now = time.time()

    # Return sport-level cache if still fresh
    if sport in _LOOKUP_CACHE:
        cached_lookup, cached_ts = _LOOKUP_CACHE[sport]
        if now - cached_ts < CACHE_TTL:
            logger.debug("Odds lookup cache hit for %s (%d games)", sport, len(cached_lookup))
            return cached_lookup

    sport_keys = SPORT_KEYS.get(sport, [])
    lookup: dict[str, dict] = {}
    all_odds: list[dict] = []
    any_fresh = False

    for i, sk in enumerate(sport_keys):
        if i > 0:
            time.sleep(0.5)  # avoid 429 rate limit between requests
        market_str = ",".join(ALL_MARKETS)
        cache_key  = f"{sk}|{market_str}"
        is_cached  = cache_key in _CACHE and now - _CACHE_TS.get(cache_key, 0) < CACHE_TTL
        events = _fetch_sport_odds(sk)
        if not is_cached and events:
            any_fresh = True
        for ev in events:
            odds = _best_odds(ev)
            odds["sport"] = sport
            key = (_normalize_team(ev["home_team"]), _normalize_team(ev["away_team"]))
            lookup[key] = odds
            all_odds.append(odds)

    # Persist snapshot only on a real API fetch
    if any_fresh and all_odds:
        _persist_snapshots(sport, all_odds)

    # Store in sport-level cache
    _LOOKUP_CACHE[sport] = (lookup, now)

    logger.info("Odds lookup for %s: %d games (fresh=%s)", sport, len(lookup), any_fresh)
    return lookup


def enrich_game_with_odds(game: dict, lookup: dict) -> dict:
    """
    Try to find real odds for a game dict from the lookup.
    Returns the game dict with home_odds / away_odds filled in if found,
    plus bookmaker detail fields.
    """
    hn = _normalize_team(game.get("home_team", ""))
    an = _normalize_team(game.get("away_team", ""))

    # Exact key match
    odds = lookup.get((hn, an))

    # Fuzzy: check if normalized name is a substring
    if odds is None:
        for (lh, la), v in lookup.items():
            if (hn in lh or lh in hn) and (an in la or la in an):
                odds = v
                break

    if odds is None:
        return game

    enriched = dict(game)
    if odds.get("home_odds"):
        enriched["home_odds"]         = odds["home_odds"]
        enriched["away_odds"]         = odds["away_odds"]
        enriched["draw_odds"]         = odds.get("draw_odds")
        enriched["home_bk"]           = odds.get("home_bk")
        enriched["away_bk"]           = odds.get("away_bk")
        enriched["draw_bk"]           = odds.get("draw_bk")
        enriched["home_fanduel"]      = odds.get("home_fanduel")
        enriched["away_fanduel"]      = odds.get("away_fanduel")
        enriched["draw_fanduel"]      = odds.get("draw_fanduel")
        enriched["home_draftkings"]   = odds.get("home_draftkings")
        enriched["away_draftkings"]   = odds.get("away_draftkings")
        enriched["draw_draftkings"]   = odds.get("draw_draftkings")
        enriched["odds_source"]       = "the_odds_api"
    # Spreads
    if odds.get("home_spread") is not None:
        enriched["home_spread"]       = odds["home_spread"]
        enriched["away_spread"]       = odds["away_spread"]
        enriched["home_spread_odds"]  = odds.get("home_spread_odds")
        enriched["away_spread_odds"]  = odds.get("away_spread_odds")
        enriched["spread_bk"]         = odds.get("spread_bk")
    # Totals
    if odds.get("total_line") is not None:
        enriched["total_line"]        = odds["total_line"]
        enriched["over_odds"]         = odds.get("over_odds")
        enriched["under_odds"]        = odds.get("under_odds")
        enriched["totals_bk"]         = odds.get("totals_bk")
    return enriched


def get_odds_movement(hours: int = 24) -> list[dict]:
    """
    Return odds movement data for all games with 2+ snapshots in the last `hours` hours.

    For each game, compares the EARLIEST snapshot vs the LATEST snapshot and
    returns the delta for home_odds, away_odds, draw_odds, and total_line.

    Returns list of dicts: {home_team, away_team, sport, commence_time,
      home_odds_open, home_odds_now, home_odds_move,
      away_odds_open, away_odds_now, away_odds_move,
      draw_odds_open, draw_odds_now, draw_odds_move,
      total_open, total_now, total_move,
      snapshot_count, first_seen, last_seen}
    """
    try:
        _init_snapshots_table()
        with _db() as conn:
            rows = conn.execute("""
                SELECT home_team, away_team, sport, commence_time,
                       MIN(fetched_at) as first_seen,
                       MAX(fetched_at) as last_seen,
                       COUNT(*) as snapshot_count
                FROM odds_snapshots
                WHERE fetched_at >= datetime('now', ? || ' hours')
                GROUP BY home_team, away_team
                HAVING COUNT(*) >= 2
                ORDER BY last_seen DESC
            """, (f"-{hours}",)).fetchall()

            results = []
            for r in rows:
                ht, at = r["home_team"], r["away_team"]
                # Earliest snapshot
                first = conn.execute("""
                    SELECT home_odds, away_odds, draw_odds, total_line
                    FROM odds_snapshots
                    WHERE home_team=? AND away_team=?
                    ORDER BY fetched_at ASC LIMIT 1
                """, (ht, at)).fetchone()
                # Latest snapshot
                last = conn.execute("""
                    SELECT home_odds, away_odds, draw_odds, total_line
                    FROM odds_snapshots
                    WHERE home_team=? AND away_team=?
                    ORDER BY fetched_at DESC LIMIT 1
                """, (ht, at)).fetchone()

                if not first or not last:
                    continue

                def _delta(a, b):
                    if a is None or b is None:
                        return None
                    return round(b - a, 3)

                results.append({
                    "home_team":       ht,
                    "away_team":       at,
                    "sport":           r["sport"],
                    "commence_time":   r["commence_time"],
                    "snapshot_count":  r["snapshot_count"],
                    "first_seen":      r["first_seen"],
                    "last_seen":       r["last_seen"],
                    # Home moneyline
                    "home_odds_open":  first["home_odds"],
                    "home_odds_now":   last["home_odds"],
                    "home_odds_move":  _delta(first["home_odds"], last["home_odds"]),
                    # Away moneyline
                    "away_odds_open":  first["away_odds"],
                    "away_odds_now":   last["away_odds"],
                    "away_odds_move":  _delta(first["away_odds"], last["away_odds"]),
                    # Draw (soccer)
                    "draw_odds_open":  first["draw_odds"],
                    "draw_odds_now":   last["draw_odds"],
                    "draw_odds_move":  _delta(first["draw_odds"], last["draw_odds"]),
                    # Total line
                    "total_open":      first["total_line"],
                    "total_now":       last["total_line"],
                    "total_move":      _delta(first["total_line"], last["total_line"]),
                })
            return results
    except Exception as exc:
        logger.warning("get_odds_movement failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# NBA Player Props
# ---------------------------------------------------------------------------

# Cache: {event_id: (props_list, timestamp)}
_PROPS_CACHE: dict[str, tuple[list, float]] = {}
_NBA_EVENT_PLAYER_TEAM_CACHE: dict[str, tuple[dict[str, dict[str, str]], float]] = {}


def _init_nba_open_props_table() -> None:
    with _db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS nba_open_props (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                opened_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                event_id TEXT NOT NULL,
                home_team TEXT,
                away_team TEXT,
                player TEXT NOT NULL,
                team TEXT,
                team_abbr TEXT,
                team_logo TEXT,
                opponent TEXT,
                opponent_logo TEXT,
                player_headshot TEXT,
                market TEXT NOT NULL,
                market_label TEXT,
                line REAL,
                over_odds REAL,
                under_odds REAL,
                best_bk TEXT,
                fanduel_line REAL,
                fanduel_over REAL,
                fanduel_under REAL,
                draftkings_line REAL,
                draftkings_over REAL,
                draftkings_under REAL,
                UNIQUE(event_id, player, market)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_nba_open_props_event
            ON nba_open_props(event_id, market)
            """
        )


def _save_open_props(event_id: str, props: list[dict], overwrite: bool = False) -> int:
    if not props:
        return 0
    _init_nba_open_props_table()
    now_iso = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with _db() as conn:
        for p in props:
            fields = (
                event_id,
                p.get("home_team"),
                p.get("away_team"),
                p.get("player"),
                p.get("team"),
                p.get("team_abbr"),
                p.get("team_logo"),
                p.get("opponent"),
                p.get("opponent_logo"),
                p.get("player_headshot"),
                p.get("market"),
                p.get("market_label"),
                p.get("line"),
                p.get("over_odds"),
                p.get("under_odds"),
                p.get("best_bk"),
                p.get("fanduel_line"),
                p.get("fanduel_over"),
                p.get("fanduel_under"),
                p.get("draftkings_line"),
                p.get("draftkings_over"),
                p.get("draftkings_under"),
            )
            if overwrite:
                conn.execute(
                    """
                    INSERT INTO nba_open_props (
                        opened_at, updated_at, event_id, home_team, away_team, player, team, team_abbr, team_logo,
                        opponent, opponent_logo, player_headshot, market, market_label, line, over_odds, under_odds,
                        best_bk, fanduel_line, fanduel_over, fanduel_under, draftkings_line, draftkings_over, draftkings_under
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(event_id, player, market) DO UPDATE SET
                        updated_at=excluded.updated_at,
                        home_team=excluded.home_team,
                        away_team=excluded.away_team,
                        team=excluded.team,
                        team_abbr=excluded.team_abbr,
                        team_logo=excluded.team_logo,
                        opponent=excluded.opponent,
                        opponent_logo=excluded.opponent_logo,
                        player_headshot=excluded.player_headshot,
                        market_label=excluded.market_label,
                        line=excluded.line,
                        over_odds=excluded.over_odds,
                        under_odds=excluded.under_odds,
                        best_bk=excluded.best_bk,
                        fanduel_line=excluded.fanduel_line,
                        fanduel_over=excluded.fanduel_over,
                        fanduel_under=excluded.fanduel_under,
                        draftkings_line=excluded.draftkings_line,
                        draftkings_over=excluded.draftkings_over,
                        draftkings_under=excluded.draftkings_under
                    """,
                    (now_iso, now_iso, *fields),
                )
                inserted += 1
            else:
                cur = conn.execute(
                    """
                    INSERT OR IGNORE INTO nba_open_props (
                        opened_at, updated_at, event_id, home_team, away_team, player, team, team_abbr, team_logo,
                        opponent, opponent_logo, player_headshot, market, market_label, line, over_odds, under_odds,
                        best_bk, fanduel_line, fanduel_over, fanduel_under, draftkings_line, draftkings_over, draftkings_under
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (now_iso, now_iso, *fields),
                )
                inserted += cur.rowcount or 0
    return inserted


def _load_open_props(event_id: str) -> list[dict]:
    _init_nba_open_props_table()
    with _db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM nba_open_props
            WHERE event_id=?
            ORDER BY market, player
            """,
            (event_id,),
        ).fetchall()
    return [{k: r[k] for k in r.keys() if k not in ("id",)} for r in rows]

NBA_PROP_MARKETS = [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_threes",
    "player_steals",
    "player_blocks",
    "player_points_rebounds_assists",
    "player_points_rebounds",
    "player_points_assists",
    "player_rebounds_assists",
]
NBA_PROP_LABELS = {
    "player_points":                    "Points",
    "player_rebounds":                  "Rebounds",
    "player_assists":                   "Assists",
    "player_threes":                    "3-Pointers",
    "player_steals":                    "Steals",
    "player_blocks":                    "Blocks",
    "player_points_rebounds_assists":   "Pts+Reb+Ast",
    "player_points_rebounds":           "Pts+Reb",
    "player_points_assists":            "Pts+Ast",
    "player_rebounds_assists":          "Reb+Ast",
}


def fetch_nba_player_props(event_id: str, home_team: str, away_team: str) -> list[dict]:
    """
    Fetch NBA player props (points/rebounds/assists) for a specific event.
    Returns list of:
      {player, team, market, market_label, line, over_odds, under_odds,
       best_bk, fanduel_over, fanduel_under, draftkings_over, draftkings_under}

    Uses event-specific endpoint to avoid burning extra API quota.
    Cached per event_id for 15 minutes.
    """
    now = time.time()
    if event_id in _PROPS_CACHE:
        cached, ts = _PROPS_CACHE[event_id]
        if now - ts < CACHE_TTL:
            return cached

    if not THE_ODDS_API_KEY:
        return []

    market_str = ",".join(NBA_PROP_MARKETS)
    try:
        r = requests.get(
            f"{BASE_URL}/sports/basketball_nba/events/{event_id}/odds",
            params={
                "apiKey":     THE_ODDS_API_KEY,
                "regions":    "us",
                "markets":    market_str,
                "oddsFormat": "decimal",
                "bookmakers": "fanduel,draftkings,betmgm",
            },
            timeout=12,
        )
        remaining = r.headers.get("x-requests-remaining", "?")
        logger.info("NBA props %s: status=%s remaining=%s", event_id[:8], r.status_code, remaining)
        if r.status_code != 200:
            return []
        data = r.json()
    except Exception as exc:
        logger.warning("NBA props fetch failed %s: %s", event_id, exc)
        return []

    # Build player → {market → {bk → {over,under,line}}} structure
    player_data: dict[str, dict] = {}  # player -> market -> bk -> odds

    def _event_player_team_map() -> dict[str, dict[str, str]]:
        now_local = time.time()
        cached = _NBA_EVENT_PLAYER_TEAM_CACHE.get(event_id)
        if cached and now_local - cached[1] < CACHE_TTL:
            return cached[0]

        out: dict[str, dict[str, str]] = {}

        def _build_from_summary(summary_obj: dict) -> None:
            teams_meta = []
            for team_obj in (summary_obj.get("boxscore", {}) or {}).get("players", []):
                tm = team_obj.get("team", {}) or {}
                teams_meta.append({
                    "id": str(tm.get("id", "") or ""),
                    "name": tm.get("displayName", ""),
                    "abbr": tm.get("abbreviation", ""),
                    "logo": tm.get("logo", ""),
                })
            for team_obj in (summary_obj.get("boxscore", {}) or {}).get("players", []):
                team_meta = team_obj.get("team", {})
                tname = team_meta.get("displayName", "")
                tabbr = team_meta.get("abbreviation", "")
                tid = str(team_meta.get("id", "") or "")
                tlogo = team_meta.get("logo", "")
                opp = next((t for t in teams_meta if t.get("id") != tid), {})
                for stats_obj in team_obj.get("statistics", []):
                    for ath in stats_obj.get("athletes", []):
                        ath_meta = ath.get("athlete", {}) or {}
                        name = ath_meta.get("displayName", "")
                        headshot = (ath_meta.get("headshot", {}) or {}).get("href", "")
                        if name:
                            out[name.lower()] = {
                                "team": tname,
                                "team_abbr": tabbr,
                                "team_logo": tlogo,
                                "opponent": opp.get("name", ""),
                                "opponent_logo": opp.get("logo", ""),
                                "headshot": headshot,
                            }

        try:
            s = requests.get(
                "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary",
                params={"event": event_id},
                timeout=10,
            ).json()
            _build_from_summary(s)

            # Fallback for Odds API event IDs (not ESPN IDs):
            # find matching ESPN event by teams + date window and rebuild from that summary.
            if not out:
                home_norm = _normalize_team(home_team)
                away_norm = _normalize_team(away_team)
                now_utc = datetime.now(timezone.utc)
                for off in (-1, 0, 1):
                    dstr = (now_utc + timedelta(days=off)).strftime("%Y%m%d")
                    sb = requests.get(
                        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
                        params={"dates": dstr},
                        timeout=10,
                    ).json()
                    found_id = None
                    for ev in sb.get("events", []) or []:
                        comp = (ev.get("competitions") or [{}])[0]
                        comps = comp.get("competitors", []) or []
                        if len(comps) < 2:
                            continue
                        names = {_normalize_team((c.get("team", {}) or {}).get("displayName", "")) for c in comps}
                        if home_norm in names and away_norm in names:
                            found_id = ev.get("id")
                            break
                    if found_id:
                        s2 = requests.get(
                            "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary",
                            params={"event": found_id},
                            timeout=10,
                        ).json()
                        _build_from_summary(s2)
                        if out:
                            break
        except Exception as exc:
            logger.debug("ESPN roster map failed for %s: %s", event_id, exc)

        _NBA_EVENT_PLAYER_TEAM_CACHE[event_id] = (out, now_local)
        return out

    team_map = _event_player_team_map()

    for bk in data.get("bookmakers", []):
        bk_key = bk.get("key", "")
        for mkt in bk.get("markets", []):
            mkt_key = mkt.get("key", "")
            if mkt_key not in NBA_PROP_MARKETS:
                continue
            for o in mkt.get("outcomes", []):
                player = o.get("description", "")
                side   = o.get("name", "")   # "Over" or "Under"
                line   = o.get("point")
                price  = o.get("price")
                if not player or not side or line is None or price is None:
                    continue
                player_data.setdefault(player, {})
                player_data[player].setdefault(mkt_key, {})
                player_data[player][mkt_key].setdefault(bk_key, {"line": line, "over": None, "under": None})
                if side == "Over":
                    player_data[player][mkt_key][bk_key]["over"] = price
                    player_data[player][mkt_key][bk_key]["line"] = line
                elif side == "Under":
                    player_data[player][mkt_key][bk_key]["under"] = price

    # Flatten to list of prop dicts
    props: list[dict] = []
    for player, mkts in player_data.items():
        for mkt_key, bks in mkts.items():
            # Best odds = highest over_odds across bookmakers
            best_over  = None
            best_under = None
            best_line  = None
            best_bk    = None
            fd_over = fd_under = dk_over = dk_under = None
            fd_line = dk_line = None

            for bk_key, od in bks.items():
                line  = od.get("line")
                over  = od.get("over")
                under = od.get("under")
                if bk_key == "fanduel":
                    fd_over, fd_under, fd_line = over, under, line
                if bk_key == "draftkings":
                    dk_over, dk_under, dk_line = over, under, line
                if over and (best_over is None or over > best_over):
                    best_over  = over
                    best_line  = line
                    best_bk    = bk_key
                if under and (best_under is None or under > best_under):
                    best_under = under

            if best_line is None:
                continue

            # Determine which team the player belongs to via ESPN event roster map
            key = player.lower()
            team_info = team_map.get(key)
            if not team_info and team_map:
                close = get_close_matches(key, team_map.keys(), n=1, cutoff=0.88)
                if close:
                    team_info = team_map.get(close[0])

            # If we have a roster map for this event and player isn't in it,
            # skip this row to avoid cross-game misplacement.
            if team_map and not team_info:
                continue

            team = (team_info or {}).get("team") or ""
            team_abbr = (team_info or {}).get("team_abbr") or ""
            opponent = (team_info or {}).get("opponent") or ""
            team_logo = (team_info or {}).get("team_logo") or ""
            opponent_logo = (team_info or {}).get("opponent_logo") or ""
            player_headshot = (team_info or {}).get("headshot") or ""
            props.append({
                "event_id":        event_id,
                "home_team":       home_team,
                "away_team":       away_team,
                "player":          player,
                "team":            team,
                "team_abbr":       team_abbr,
                "team_logo":       team_logo,
                "opponent":        opponent,
                "opponent_logo":   opponent_logo,
                "player_headshot": player_headshot,
                "market":          mkt_key,
                "market_label":    NBA_PROP_LABELS.get(mkt_key, mkt_key),
                "line":            best_line,
                "over_odds":       best_over,
                "under_odds":      best_under,
                "best_bk":         best_bk,
                "fanduel_line":    fd_line,
                "fanduel_over":    fd_over,
                "fanduel_under":   fd_under,
                "draftkings_line": dk_line,
                "draftkings_over": dk_over,
                "draftkings_under": dk_under,
            })

    props.sort(key=lambda p: (p["market"], p["player"]))
    _PROPS_CACHE[event_id] = (props, now)
    logger.info("NBA props %s: %d player-market combos", event_id[:8], len(props))
    return props


def fetch_nba_player_props_open(event_id: str, home_team: str, away_team: str) -> list[dict]:
    """
    Open-lines mode for NBA props:
      1) Read persisted first-seen lines from DB
      2) If missing, fetch live once, persist as open snapshot, then return
    """
    rows = _load_open_props(event_id)
    if rows:
        return rows

    live = fetch_nba_player_props(event_id, home_team, away_team)
    if live:
        _save_open_props(event_id, live, overwrite=False)
        return _load_open_props(event_id)
    return []


def refresh_nba_open_lines(force_update: bool = False) -> dict:
    """Populate/refresh persisted open-line snapshot for upcoming NBA events."""
    events = get_nba_event_ids()
    touched_events = 0
    inserted_rows = 0

    for ev in events:
        props = fetch_nba_player_props(ev["event_id"], ev["home_team"], ev["away_team"])
        if not props:
            continue
        touched_events += 1
        inserted_rows += _save_open_props(ev["event_id"], props, overwrite=force_update)

    return {
        "events_seen": len(events),
        "events_with_props": touched_events,
        "rows_written": inserted_rows,
        "mode": "overwrite" if force_update else "open_only",
    }


def get_nba_event_ids() -> list[dict]:
    """
    Return list of {event_id, home_team, away_team, commence_time}
    for upcoming NBA games.
    Reuses the same cache entry as the main picks fetch (ALL_MARKETS)
    so no extra API calls are made.
    """
    events = _fetch_sport_odds("basketball_nba")  # uses ALL_MARKETS — hits same cache key
    out = []
    for e in events:
        odds = _best_odds(e)
        out.append({
            "event_id":      e["id"],
            "home_team":     e["home_team"],
            "away_team":     e["away_team"],
            "commence_time": e.get("commence_time", ""),
            "home_odds":     odds.get("home_odds"),
            "away_odds":     odds.get("away_odds"),
        })
    return out


# ---------------------------------------------------------------------------
# Soccer Alternate Markets (BTTS, Draw No Bet, Player Goal Scorer)
# ---------------------------------------------------------------------------

# Cache: {event_id: (alt_dict, timestamp)}
_ALT_CACHE: dict[str, tuple[dict, float]] = {}

SOCCER_ALT_MARKETS = ["btts", "draw_no_bet", "player_goal_scorer_anytime"]
SOCCER_ALT_REGIONS = "eu,uk"


def fetch_soccer_alt_markets(sport_key: str, event_id: str, home_team: str, away_team: str) -> dict:
    """
    Fetch BTTS, Draw No Bet, and player goal scorer odds for a soccer event.
    Returns:
      {
        btts_yes_odds, btts_no_odds, btts_bk,
        dnb_home_odds, dnb_away_odds, dnb_bk,
        goal_scorers: [{player, odds, bk}, ...]
      }
    Cached per event_id for 15 minutes.
    """
    now = time.time()
    if event_id in _ALT_CACHE:
        cached, ts = _ALT_CACHE[event_id]
        if now - ts < CACHE_TTL:
            return cached

    if not THE_ODDS_API_KEY:
        return {}

    market_str = ",".join(SOCCER_ALT_MARKETS)
    try:
        r = requests.get(
            f"{BASE_URL}/sports/{sport_key}/events/{event_id}/odds",
            params={
                "apiKey":     THE_ODDS_API_KEY,
                "regions":    SOCCER_ALT_REGIONS,
                "markets":    market_str,
                "oddsFormat": "decimal",
            },
            timeout=12,
        )
        remaining = r.headers.get("x-requests-remaining", "?")
        logger.info("Soccer alt %s %s: status=%s remaining=%s", sport_key, event_id[:8], r.status_code, remaining)
        if r.status_code != 200:
            return {}
        data = r.json()
    except Exception as exc:
        logger.warning("Soccer alt fetch failed %s/%s: %s", sport_key, event_id, exc)
        return {}

    result: dict = {
        "btts_yes_odds":  None,
        "btts_no_odds":   None,
        "btts_bk":        None,
        "dnb_home_odds":  None,
        "dnb_away_odds":  None,
        "dnb_bk":         None,
        "goal_scorers":   [],
    }

    # Track best BTTS and DNB odds
    best_btts_yes = 0.0
    best_dnb_home = 0.0
    scorers: dict[str, dict] = {}  # player -> {odds, bk}

    for bk in data.get("bookmakers", []):
        bk_key = bk.get("key", "")
        for mkt in bk.get("markets", []):
            mkt_key = mkt.get("key", "")
            outcomes = mkt.get("outcomes", [])

            if mkt_key == "btts":
                prices = {o["name"]: o["price"] for o in outcomes}
                yes_p = prices.get("Yes")
                no_p  = prices.get("No")
                if yes_p and yes_p > best_btts_yes:
                    best_btts_yes = yes_p
                    result["btts_yes_odds"] = yes_p
                    result["btts_no_odds"]  = no_p
                    result["btts_bk"]       = bk_key

            elif mkt_key == "draw_no_bet":
                prices = {o["name"]: o["price"] for o in outcomes}
                hp = prices.get(home_team)
                ap = prices.get(away_team)
                if hp and hp > best_dnb_home:
                    best_dnb_home = hp
                    result["dnb_home_odds"] = hp
                    result["dnb_away_odds"] = ap
                    result["dnb_bk"]        = bk_key

            elif mkt_key == "player_goal_scorer_anytime":
                for o in outcomes:
                    player = o.get("description", "")
                    price  = o.get("price")
                    if not player or not price:
                        continue
                    if player not in scorers or price > scorers[player]["odds"]:
                        scorers[player] = {"odds": price, "bk": bk_key}

    # Top 10 goal scorers sorted by odds ascending (most likely first)
    result["goal_scorers"] = sorted(
        [{"player": p, "odds": v["odds"], "bk": v["bk"]} for p, v in scorers.items()],
        key=lambda x: x["odds"]
    )[:10]

    _ALT_CACHE[event_id] = (result, now)
    return result


def get_soccer_event_ids(sport_key: str) -> list[dict]:
    """Return list of {event_id, home_team, away_team} for a soccer sport key."""
    events = _fetch_sport_odds(sport_key, markets=["h2h"])
    return [
        {
            "event_id":      e["id"],
            "sport_key":     sport_key,
            "home_team":     e["home_team"],
            "away_team":     e["away_team"],
            "commence_time": e.get("commence_time", ""),
        }
        for e in events
    ]
