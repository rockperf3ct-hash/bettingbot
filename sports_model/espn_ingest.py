"""
ESPN Scoreboard + MLB Stats API ingestion module.

Normalises raw API responses into the shared game schema expected by
sports_model.features.build_features():

Required columns:
    date, league, home_team, away_team, home_score, away_score,
    home_odds, away_odds

Optional columns (populated where available):
    home_rest_days, away_rest_days, is_b2b_home, is_b2b_away,
    home_possession, away_possession, home_shots, away_shots,
    home_shots_on_target, away_shots_on_target,
    home_corners, away_corners, home_fouls, away_fouls,
    draw_odds, total_line, over_odds, under_odds,
    venue, status, sport

Public API (no key required):
  ESPN scoreboard  – https://site.api.espn.com/apis/site/v2/sports/...
  MLB Stats API    – https://statsapi.mlb.com/api/v1/...
"""

from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from typing import Any

import pandas as pd
import requests

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ESPN league map
# ---------------------------------------------------------------------------

ESPN_LEAGUES: dict[str, dict[str, str]] = {
    # Soccer
    "epl":          {"sport": "soccer",     "league_key": "eng.1",           "display": "EPL"},
    "bundesliga":   {"sport": "soccer",     "league_key": "ger.1",           "display": "Bundesliga"},
    "laliga":       {"sport": "soccer",     "league_key": "esp.1",           "display": "LaLiga"},
    "liga_mx":      {"sport": "soccer",     "league_key": "mex.1",           "display": "Liga MX"},
    "ucl":          {"sport": "soccer",     "league_key": "uefa.champions",  "display": "UCL"},
    "europa":       {"sport": "soccer",     "league_key": "uefa.europa",     "display": "Europa League"},
    # Basketball
    "nba":          {"sport": "basketball", "league_key": "nba",             "display": "NBA"},
}

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports"
MLB_SCHEDULE_BASE = "https://statsapi.mlb.com/api/v1/schedule"

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "sports-model/1.0 (educational)"})

# ESPN uses multiple "completed" status strings across sports/regions
_COMPLETED_STATUSES = {
    "status_final", "status_full_time", "status_final_aet",
    "status_final_pen", "final", "full time",
}


def _is_completed(status: str) -> bool:
    """Return True if the ESPN/MLB status string indicates a finished game."""
    s = status.lower().replace(" ", "_")
    return any(c in s for c in _COMPLETED_STATUSES)


# ---------------------------------------------------------------------------
# Low-level fetch helpers
# ---------------------------------------------------------------------------

def _get(url: str, params: dict | None = None, retries: int = 3, backoff: float = 1.5) -> dict:
    """GET with retry/backoff. Returns parsed JSON dict."""
    for attempt in range(retries):
        try:
            r = _SESSION.get(url, params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as exc:
            if attempt == retries - 1:
                logger.error("Failed %s after %d attempts: %s", url, retries, exc)
                raise
            wait = backoff * (2 ** attempt)
            logger.warning("Attempt %d failed (%s), retrying in %.1fs", attempt + 1, exc, wait)
            time.sleep(wait)
    return {}


def _espn_scoreboard_url(sport: str, league_key: str) -> str:
    return f"{ESPN_BASE}/{sport}/{league_key}/scoreboard"


# ---------------------------------------------------------------------------
# ESPN odds extractor
# ---------------------------------------------------------------------------

def _parse_espn_odds(competition: dict) -> dict[str, float | None]:
    """Extract moneyline / spread / total / draw from ESPN odds node."""
    result: dict[str, float | None] = {
        "home_odds": None,
        "away_odds": None,
        "draw_odds": None,
        "total_line": None,
        "over_odds": None,
        "under_odds": None,
    }
    odds_list: list[dict] = [o for o in competition.get("odds", []) if o and isinstance(o, dict)]
    if not odds_list:
        return result

    # prefer DraftKings, fall back to first available
    provider = next(
        (o for o in odds_list if "draftkings" in (o.get("provider") or {}).get("name", "").lower()),
        odds_list[0],
    )

    # moneyline
    ml_home = provider.get("homeTeamOdds", {})
    ml_away = provider.get("awayTeamOdds", {})

    def _ml_to_decimal(ml_str: str | None) -> float | None:
        """Convert American moneyline string (e.g. '+150', '-110') to decimal odds."""
        if not ml_str:
            return None
        try:
            ml = float(str(ml_str).replace("+", ""))
            return round((ml / 100 + 1) if ml > 0 else (100 / abs(ml) + 1), 3)
        except (ValueError, ZeroDivisionError):
            return None

    result["home_odds"] = _ml_to_decimal(ml_home.get("moneyLine"))
    result["away_odds"] = _ml_to_decimal(ml_away.get("moneyLine"))

    # draw (soccer only)
    draw_ml = provider.get("drawOdds", {}).get("moneyLine")
    result["draw_odds"] = _ml_to_decimal(draw_ml)

    # over/under total
    over_under = provider.get("overUnder")
    if over_under:
        try:
            result["total_line"] = float(over_under)
        except (TypeError, ValueError):
            pass
    result["over_odds"] = _ml_to_decimal(provider.get("overOdds"))
    result["under_odds"] = _ml_to_decimal(provider.get("underOdds"))

    return result


# ---------------------------------------------------------------------------
# ESPN stat extractor
# ---------------------------------------------------------------------------

_SOCCER_STAT_MAP = {
    "Possession": ("possession", float),
    "Shots": ("shots", int),
    "Shots on Target": ("shots_on_target", int),
    "Corner Kicks": ("corners", int),
    "Fouls": ("fouls", int),
    "Yellow Cards": ("yellow_cards", int),
    "Red Cards": ("red_cards", int),
    "Saves": ("saves", int),
}

_NBA_STAT_MAP = {
    "Field Goal %": ("fg_pct", float),
    "Three Point %": ("fg3_pct", float),
    "Free Throw %": ("ft_pct", float),
    "Rebounds": ("rebounds", int),
    "Assists": ("assists", int),
    "Turnovers": ("turnovers", int),
    "Points in Paint": ("paint_points", int),
    "Fast Break Points": ("fast_break_points", int),
}


def _parse_espn_team_stats(competitor: dict, sport: str) -> dict[str, Any]:
    """Extract per-team stats from ESPN competitor node."""
    stats_out: dict[str, Any] = {}
    stat_map = _SOCCER_STAT_MAP if sport == "soccer" else _NBA_STAT_MAP
    statistics = competitor.get("statistics", [])
    for stat in statistics:
        name = stat.get("name", "")
        if name in stat_map:
            key, cast = stat_map[name]
            raw = stat.get("displayValue") or stat.get("value")
            if raw is not None:
                try:
                    stats_out[key] = cast(str(raw).replace("%", "").strip())
                except (ValueError, TypeError):
                    pass
    return stats_out


# ---------------------------------------------------------------------------
# ESPN single event → game row
# ---------------------------------------------------------------------------

def _parse_espn_event(event: dict, league_display: str, sport: str) -> dict | None:
    """Convert a single ESPN scoreboard event to a game-schema row."""
    competitions = event.get("competitions", [])
    if not competitions:
        return None
    comp = competitions[0]

    competitors = comp.get("competitors", [])
    if len(competitors) < 2:
        return None

    # ESPN marks homeAway = "home" / "away"
    home_comp = next((c for c in competitors if c.get("homeAway") == "home"), None)
    away_comp = next((c for c in competitors if c.get("homeAway") == "away"), None)
    if not home_comp or not away_comp:
        return None

    home_team = home_comp.get("team", {}).get("displayName") or home_comp.get("team", {}).get("name", "Unknown")
    away_team = away_comp.get("team", {}).get("displayName") or away_comp.get("team", {}).get("name", "Unknown")

    # Scores — absent for future/scheduled games; use None to distinguish from real 0
    try:
        raw_h = home_comp.get("score")
        raw_a = away_comp.get("score")
        home_score = int(raw_h) if raw_h not in (None, "", "null") else None
        away_score = int(raw_a) if raw_a not in (None, "", "null") else None
    except (TypeError, ValueError):
        home_score = None
        away_score = None

    # Date
    raw_date = event.get("date", "")
    try:
        game_date = pd.Timestamp(raw_date, tz="UTC")
    except Exception:
        game_date = pd.Timestamp.utcnow()

    # Status
    status_node = comp.get("status", {})
    status_type = status_node.get("type", {})
    status = status_type.get("name", "STATUS_UNKNOWN")   # STATUS_FINAL, STATUS_IN_PROGRESS, STATUS_SCHEDULED

    # Venue
    venue_node = comp.get("venue", {})
    venue = venue_node.get("fullName") or venue_node.get("name", "")

    # Odds
    odds_data = _parse_espn_odds(comp)

    # Team stats
    home_stats = _parse_espn_team_stats(home_comp, sport)
    away_stats = _parse_espn_team_stats(away_comp, sport)

    # Form (ESPN returns last-5 string e.g. "WWLLD")
    home_form_str = home_comp.get("form", "") or ""
    away_form_str = away_comp.get("form", "") or ""

    def _form_to_rate(form: str) -> float | None:
        if not form:
            return None
        wins = form.upper().count("W")
        return round(wins / len(form), 3)

    row: dict[str, Any] = {
        "date": game_date.isoformat(),
        "league": league_display,
        "sport": sport,
        "home_team": home_team,
        "away_team": away_team,
        "home_score": home_score,
        "away_score": away_score,
        "status": status,
        "venue": venue,
        # odds
        "home_odds": odds_data["home_odds"],
        "away_odds": odds_data["away_odds"],
        "draw_odds": odds_data["draw_odds"],
        "total_line": odds_data["total_line"],
        "over_odds": odds_data["over_odds"],
        "under_odds": odds_data["under_odds"],
        # form
        "home_form_rate": _form_to_rate(home_form_str),
        "away_form_rate": _form_to_rate(away_form_str),
        "home_form_str": home_form_str,
        "away_form_str": away_form_str,
    }

    # Flatten team stats with home_/away_ prefix
    for k, v in home_stats.items():
        row[f"home_{k}"] = v
    for k, v in away_stats.items():
        row[f"away_{k}"] = v

    return row


# ---------------------------------------------------------------------------
# ESPN public fetch functions
# ---------------------------------------------------------------------------

def fetch_espn_scoreboard(league_slug: str, game_date: date | None = None) -> list[dict]:
    """
    Fetch ESPN scoreboard for a given league slug (e.g. 'epl', 'nba').

    Parameters
    ----------
    league_slug:
        One of the keys in ESPN_LEAGUES.
    game_date:
        If provided, fetches that specific date. If None, fetches today.

    Returns
    -------
    List of game-schema dicts (may be empty if no games that day).
    """
    if league_slug not in ESPN_LEAGUES:
        raise ValueError(f"Unknown league slug '{league_slug}'. Known: {list(ESPN_LEAGUES)}")

    meta = ESPN_LEAGUES[league_slug]
    sport = meta["sport"]
    league_key = meta["league_key"]
    display = meta["display"]

    url = _espn_scoreboard_url(sport, league_key)
    params: dict[str, str] = {}
    if game_date:
        params["dates"] = game_date.strftime("%Y%m%d")

    logger.info("ESPN fetch: %s %s date=%s", league_slug, url, game_date)
    data = _get(url, params=params)

    events = data.get("events", [])
    rows = []
    for event in events:
        row = _parse_espn_event(event, display, sport)
        if row:
            rows.append(row)
    logger.info("ESPN %s: %d games parsed", league_slug, len(rows))
    return rows


def fetch_espn_all_leagues(game_date: date | None = None) -> pd.DataFrame:
    """Fetch all ESPN leagues and combine into a single DataFrame."""
    all_rows: list[dict] = []
    for slug in ESPN_LEAGUES:
        try:
            rows = fetch_espn_scoreboard(slug, game_date=game_date)
            all_rows.extend(rows)
        except Exception as exc:
            logger.error("Error fetching ESPN %s: %s", slug, exc)
    df = pd.DataFrame(all_rows)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], utc=True)
    return df.sort_values("date").reset_index(drop=True)


# ---------------------------------------------------------------------------
# MLB Stats API ingestion
# ---------------------------------------------------------------------------

def fetch_mlb_scoreboard(game_date: date | None = None) -> list[dict]:
    """
    Fetch MLB schedule/scores from the free MLB Stats API.

    Returns list of game-schema dicts.
    """
    params: dict[str, str] = {"sportId": "1", "hydrate": "boxscore,linescore,decisions"}
    if game_date:
        date_str = game_date.strftime("%Y-%m-%d")
        params["date"] = date_str
    else:
        params["date"] = date.today().strftime("%Y-%m-%d")

    logger.info("MLB Stats fetch: date=%s", params.get("date"))
    try:
        data = _get(MLB_SCHEDULE_BASE, params=params)
    except Exception as exc:
        logger.error("MLB Stats API error: %s", exc)
        return []

    rows = []
    for date_block in data.get("dates", []):
        for game in date_block.get("games", []):
            row = _parse_mlb_game(game)
            if row:
                rows.append(row)

    logger.info("MLB: %d games parsed", len(rows))
    return rows


def _parse_mlb_game(game: dict) -> dict | None:
    """Convert MLB Stats API game object to game-schema row."""
    status = game.get("status", {}).get("codedGameState", "")
    # S = scheduled, I = in progress, F = final, D = postponed
    game_status = game.get("status", {}).get("detailedState", "Scheduled")

    teams = game.get("teams", {})
    home = teams.get("home", {})
    away = teams.get("away", {})

    home_team = home.get("team", {}).get("name", "Unknown")
    away_team = away.get("team", {}).get("name", "Unknown")

    home_score = home.get("score", 0) or 0
    away_score = away.get("score", 0) or 0

    raw_date = game.get("gameDate", "")
    try:
        game_date_ts = pd.Timestamp(raw_date, tz="UTC")
    except Exception:
        game_date_ts = pd.Timestamp.utcnow()

    venue = game.get("venue", {}).get("name", "")

    # Linescore for inning-level detail
    linescore = game.get("linescore", {})

    # Pitching stats from boxscore decisions (winning/losing pitcher ERA etc.)
    decisions = game.get("decisions", {})
    winning_pitcher = decisions.get("winner", {}).get("fullName", "")
    losing_pitcher = decisions.get("loser", {}).get("fullName", "")

    # Team stats from linescore
    home_hits = linescore.get("teams", {}).get("home", {}).get("hits", None)
    away_hits = linescore.get("teams", {}).get("away", {}).get("hits", None)
    home_errors = linescore.get("teams", {}).get("home", {}).get("errors", None)
    away_errors = linescore.get("teams", {}).get("away", {}).get("errors", None)
    home_left_on_base = linescore.get("teams", {}).get("home", {}).get("leftOnBase", None)
    away_left_on_base = linescore.get("teams", {}).get("away", {}).get("leftOnBase", None)

    # MLB has no native moneyline in the free Stats API — set to None
    # These will be filled in by The Odds API enrichment step
    row: dict[str, Any] = {
        "date": game_date_ts.isoformat(),
        "league": "MLB",
        "sport": "baseball",
        "home_team": home_team,
        "away_team": away_team,
        "home_score": int(home_score),
        "away_score": int(away_score),
        "status": game_status,
        "venue": venue,
        "home_odds": None,
        "away_odds": None,
        "draw_odds": None,
        "total_line": None,
        "over_odds": None,
        "under_odds": None,
        # MLB-specific
        "home_hits": home_hits,
        "away_hits": away_hits,
        "home_errors": home_errors,
        "away_errors": away_errors,
        "home_left_on_base": home_left_on_base,
        "away_left_on_base": away_left_on_base,
        "winning_pitcher": winning_pitcher,
        "losing_pitcher": losing_pitcher,
    }
    return row


# ---------------------------------------------------------------------------
# Historical data fetcher
# ---------------------------------------------------------------------------

def fetch_historical_games(
    start_date: date,
    end_date: date,
    leagues: list[str] | None = None,
    include_mlb: bool = True,
    delay_seconds: float = 0.5,
) -> pd.DataFrame:
    """
    Iterate over a date range and collect completed games from ESPN + MLB.

    Parameters
    ----------
    start_date, end_date:
        Inclusive date range to fetch.
    leagues:
        List of ESPN league slugs (default: all). e.g. ['epl', 'nba']
    include_mlb:
        Whether to include MLB data.
    delay_seconds:
        Polite delay between API calls.

    Returns
    -------
    DataFrame with all completed games, normalised to the shared schema.
    """
    if leagues is None:
        leagues = list(ESPN_LEAGUES.keys())

    all_rows: list[dict] = []
    current = start_date

    total_days = (end_date - start_date).days + 1
    day_num = 0

    while current <= end_date:
        day_num += 1
        logger.info("Fetching %s (%d/%d)", current, day_num, total_days)

        # ESPN leagues
        for slug in leagues:
            try:
                rows = fetch_espn_scoreboard(slug, game_date=current)
                completed = [r for r in rows if _is_completed(r.get("status", ""))]
                all_rows.extend(completed)
                time.sleep(delay_seconds)
            except Exception as exc:
                logger.warning("ESPN %s %s error: %s", slug, current, exc)

        # MLB
        if include_mlb:
            try:
                mlb_rows = fetch_mlb_scoreboard(game_date=current)
                completed_mlb = [r for r in mlb_rows if _is_completed(r.get("status", ""))]
                all_rows.extend(completed_mlb)
                time.sleep(delay_seconds)
            except Exception as exc:
                logger.warning("MLB %s error: %s", current, exc)

        current += timedelta(days=1)

    df = pd.DataFrame(all_rows)
    if df.empty:
        logger.warning("No completed games found in range %s – %s", start_date, end_date)
        return df

    df["date"] = pd.to_datetime(df["date"], utc=True)
    df = df.sort_values("date").reset_index(drop=True)

    # Ensure required columns exist (fill with sensible defaults)
    for col, default in [
        ("home_odds", 2.0),
        ("away_odds", 2.0),
    ]:
        if col in df.columns:
            df[col] = df[col].fillna(default)
        else:
            df[col] = default

    logger.info("Historical fetch complete: %d games over %d days", len(df), total_days)
    return df


# ---------------------------------------------------------------------------
# Month-batch fetcher (one request per month per league — much faster)
# ---------------------------------------------------------------------------

def fetch_espn_scoreboard_month(league_slug: str, year: int, month: int) -> list[dict]:
    """
    Fetch all ESPN games for a league in a given calendar month using
    the date-range query (YYYYMMDD-YYYYMMDD) — one API call vs ~30.
    """
    import calendar as _cal
    if league_slug not in ESPN_LEAGUES:
        raise ValueError(f"Unknown league slug '{league_slug}'")

    meta = ESPN_LEAGUES[league_slug]
    sport = meta["sport"]
    league_key = meta["league_key"]
    display = meta["display"]

    last_day = _cal.monthrange(year, month)[1]
    date_range = f"{year}{month:02d}01-{year}{month:02d}{last_day:02d}"

    url = _espn_scoreboard_url(sport, league_key)
    params: dict[str, str] = {"dates": date_range, "limit": "200"}

    logger.info("ESPN month-batch: %s %d/%02d", league_slug, year, month)
    data = _get(url, params=params)

    events = data.get("events", [])
    rows = []
    for event in events:
        row = _parse_espn_event(event, display, sport)
        if row:
            rows.append(row)
    logger.info("ESPN %s %d/%02d: %d games", league_slug, year, month, len(rows))
    return rows


def fetch_historical_games_fast(
    start_date: date,
    end_date: date,
    leagues: list[str] | None = None,
    include_mlb: bool = False,
    delay_seconds: float = 0.4,
) -> pd.DataFrame:
    """
    Faster historical fetch using month-range requests (one per month per league).

    ~20x faster than the day-by-day fetch_historical_games() for multi-month ranges.
    MLB is excluded by default because the MLB API only supports single-date queries.
    """
    if leagues is None:
        leagues = list(ESPN_LEAGUES.keys())

    all_rows: list[dict] = []

    # Enumerate (year, month) pairs in range
    months: list[tuple[int, int]] = []
    cur_y, cur_m = start_date.year, start_date.month
    end_y, end_m = end_date.year, end_date.month
    while (cur_y, cur_m) <= (end_y, end_m):
        months.append((cur_y, cur_m))
        cur_m += 1
        if cur_m > 12:
            cur_m = 1
            cur_y += 1

    logger.info("Fast fetch: %d leagues × %d months", len(leagues), len(months))

    for slug in leagues:
        for year, month in months:
            try:
                rows = fetch_espn_scoreboard_month(slug, year, month)
                completed = [r for r in rows if _is_completed(r.get("status", ""))]
                all_rows.extend(completed)
                time.sleep(delay_seconds)
            except Exception as exc:
                logger.warning("ESPN %s %d/%02d error: %s", slug, year, month, exc)

    df = pd.DataFrame(all_rows)
    if df.empty:
        logger.warning("No completed games found in range %s – %s", start_date, end_date)
        return df

    df["date"] = pd.to_datetime(df["date"], utc=True, format="mixed")
    df = df.sort_values("date").reset_index(drop=True)

    for col, default in [("home_odds", 2.0), ("away_odds", 2.0)]:
        if col in df.columns:
            df[col] = df[col].fillna(default)
        else:
            df[col] = default

    # Filter to only dates within requested range
    start_ts = pd.Timestamp(start_date, tz="UTC")
    end_ts   = pd.Timestamp(end_date,   tz="UTC") + pd.Timedelta(days=1)
    df = df[(df["date"] >= start_ts) & (df["date"] < end_ts)].reset_index(drop=True)

    logger.info("Fast fetch complete: %d games", len(df))
    return df


# ---------------------------------------------------------------------------
# Upcoming schedule (next N days, all leagues)
# ---------------------------------------------------------------------------

_SCHEDULED_STATUSES = {"STATUS_SCHEDULED", "STATUS_PRE", "Scheduled", "Pre-Game"}


def fetch_upcoming_schedule(
    days_ahead: int = 7,
    leagues: list[str] | None = None,
    include_mlb: bool = True,
    start_offset_days: int = 0,
) -> pd.DataFrame:
    """
    Fetch all upcoming/scheduled games for the next `days_ahead` days
    across all ESPN leagues + MLB.

    Uses the ESPN date-range query so each league needs only ONE API call.

    Parameters
    ----------
    days_ahead:
        How many days into the future to look (default 7).
    leagues:
        ESPN league slugs to include (default: all).
    include_mlb:
        Whether to include MLB scheduled games.
    start_offset_days:
        Start from today + this offset (0 = include today).

    Returns
    -------
    DataFrame of upcoming games sorted by date.
    """
    if leagues is None:
        leagues = list(ESPN_LEAGUES.keys())

    start = date.today() + timedelta(days=start_offset_days)
    end   = date.today() + timedelta(days=start_offset_days + days_ahead)
    date_range = f"{start.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}"

    all_rows: list[dict] = []

    # ESPN leagues — one call each with date range
    for slug in leagues:
        meta = ESPN_LEAGUES[slug]
        url = _espn_scoreboard_url(meta["sport"], meta["league_key"])
        try:
            data = _get(url, params={"dates": date_range, "limit": "300"})
            for event in data.get("events", []):
                row = _parse_espn_event(event, meta["display"], meta["sport"])
                if row and row.get("status") in _SCHEDULED_STATUSES:
                    all_rows.append(row)
            time.sleep(0.35)
        except Exception as exc:
            logger.warning("Upcoming schedule fetch failed %s: %s", slug, exc)

    # MLB — must be day-by-day (API doesn't support date ranges)
    if include_mlb:
        current = start
        while current <= end:
            try:
                rows = fetch_mlb_scoreboard(game_date=current)
                for r in rows:
                    status = r.get("status", "")
                    if "Scheduled" in status or "Pre-Game" in status or status == "S":
                        all_rows.append(r)
                time.sleep(0.25)
            except Exception as exc:
                logger.warning("MLB upcoming %s failed: %s", current, exc)
            current += timedelta(days=1)

    df = pd.DataFrame(all_rows)
    if df.empty:
        return df

    df["date"] = pd.to_datetime(df["date"], utc=True, format="mixed")
    df = df.sort_values("date").reset_index(drop=True)
    logger.info("Upcoming schedule: %d games over next %d days", len(df), days_ahead)
    return df


# ---------------------------------------------------------------------------
# Quick live scoreboard snapshot (all leagues, today)
# ---------------------------------------------------------------------------

def fetch_live_scoreboard() -> pd.DataFrame:
    """
    Fetch today's live + scheduled games across all ESPN leagues + MLB.
    Returns ALL statuses (scheduled, in-progress, final).
    """
    today = date.today()
    espn_df = fetch_espn_all_leagues(game_date=today)

    mlb_rows = fetch_mlb_scoreboard(game_date=today)
    mlb_df = pd.DataFrame(mlb_rows)
    if not mlb_df.empty:
        mlb_df["date"] = pd.to_datetime(mlb_df["date"], utc=True)

    frames = [f for f in [espn_df, mlb_df] if not f.empty]
    if not frames:
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    combined = combined.sort_values("date").reset_index(drop=True)
    return combined
