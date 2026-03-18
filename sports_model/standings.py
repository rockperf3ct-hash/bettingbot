"""
Free standings data from two sources — no API keys required.

1. ESPN Standings API  (soccer all leagues + NBA)
   https://site.api.espn.com/apis/v2/sports/{sport}/{league}/standings

2. TheSportsDB (team metadata: logos, colours, founded year)
   https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t={name}

Returns DataFrames that can be merged into the game schema before
feature engineering to add table-position features.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import pandas as pd
import requests

logger = logging.getLogger(__name__)

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "sports-model/1.0 (educational)"})


# ---------------------------------------------------------------------------
# ESPN Standings API
# ---------------------------------------------------------------------------

# Map our internal league slugs → ESPN standings URL components
ESPN_STANDINGS_LEAGUES: dict[str, dict[str, str]] = {
    # Soccer
    "epl":        {"sport": "soccer",     "league": "eng.1"},
    "bundesliga": {"sport": "soccer",     "league": "ger.1"},
    "laliga":     {"sport": "soccer",     "league": "esp.1"},
    "liga_mx":    {"sport": "soccer",     "league": "mex.1"},
    "ucl":        {"sport": "soccer",     "league": "uefa.champions"},
    "europa":     {"sport": "soccer",     "league": "uefa.europa"},
    # Basketball
    "nba":        {"sport": "basketball", "league": "nba"},
    # Baseball
    "mlb":        {"sport": "baseball",   "league": "mlb"},
}

ESPN_STANDINGS_BASE = "https://site.api.espn.com/apis/v2/sports"

# Stats we want to extract per team entry
SOCCER_STATS = ["rank", "points", "wins", "losses", "ties", "pointsFor", "pointsAgainst", "pointDifferential", "gamesPlayed"]
NBA_STATS    = ["rank", "wins", "losses", "winPercent", "gamesBack", "pointsFor", "pointsAgainst", "streak"]
MLB_STATS    = ["wins", "losses", "winPercent", "gamesBehind", "pointsFor", "pointsAgainst", "streak",
                "homeWins", "homeLosses", "roadWins", "roadLosses", "gamesPlayed"]


def _get(url: str, params: dict | None = None) -> dict:
    try:
        r = _SESSION.get(url, params=params, timeout=12)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        logger.error("ESPN standings fetch failed %s: %s", url, exc)
        return {}


def _extract_stats(entry: dict, wanted: list[str]) -> dict[str, Any]:
    """Pull stat values from an ESPN standings entry."""
    out: dict[str, Any] = {}
    for stat in entry.get("stats", []):
        name = stat.get("name", "")
        if name in wanted:
            out[name] = stat.get("value")
    return out


def fetch_espn_standings(league_slug: str) -> pd.DataFrame:
    """
    Fetch current standings for a league.

    Returns a DataFrame with one row per team:
        team_name, league_slug, rank, points, wins, losses, ties,
        goals_for, goals_against, goal_diff, games_played  (soccer)
        OR
        team_name, league_slug, rank, wins, losses, win_pct,
        games_back, points_for, points_against, streak        (NBA)
    """
    if league_slug not in ESPN_STANDINGS_LEAGUES:
        raise ValueError(f"Unknown league slug '{league_slug}'")

    meta = ESPN_STANDINGS_LEAGUES[league_slug]
    sport = meta["sport"]
    league = meta["league"]
    url = f"{ESPN_STANDINGS_BASE}/{sport}/{league}/standings"

    # For MLB regular season use season=2026&seasontype=2 (AL/NL standings; 0-0 until season starts)
    if league_slug == "mlb":
        params = {"season": "2026", "seasontype": "2"}
    else:
        params = None
    logger.info("Fetching ESPN standings: %s", url)
    data = _get(url, params=params)

    rows: list[dict] = []
    children = data.get("children", [])

    # For league-style competitions there is one child group; for NBA there are two (conferences)
    for group in children:
        group_name = group.get("name", "")
        entries = group.get("standings", {}).get("entries", [])
        wanted = SOCCER_STATS if sport == "soccer" else (MLB_STATS if league_slug == "mlb" else NBA_STATS)
        for rank_idx, entry in enumerate(entries, start=1):
            team = entry.get("team", {})
            stats = _extract_stats(entry, wanted)
            row: dict[str, Any] = {
                "league_slug": league_slug,
                "group": group_name,
                "team_name": team.get("displayName", ""),
                "team_abbr": team.get("abbreviation", ""),
                "team_logo": team.get("logos", [{}])[0].get("href", "") if team.get("logos") else "",
            }
            # Normalise stat names for shared schema
            if sport == "soccer":
                row.update({
                    "standing_rank":    stats.get("rank"),
                    "standing_points":  stats.get("points"),
                    "standing_wins":    stats.get("wins"),
                    "standing_losses":  stats.get("losses"),
                    "standing_draws":   stats.get("ties"),
                    "standing_gf":      stats.get("pointsFor"),
                    "standing_ga":      stats.get("pointsAgainst"),
                    "standing_gd":      stats.get("pointDifferential"),
                    "standing_played":  stats.get("gamesPlayed"),
                    "standing_win_pct": (stats.get("wins", 0) or 0) / max((stats.get("gamesPlayed", 1) or 1), 1),
                })
            elif league_slug == "mlb":
                w = stats.get("wins", 0) or 0
                l = stats.get("losses", 0) or 0
                gp = stats.get("gamesPlayed") or (w + l) or 1
                row.update({
                    "standing_rank":     rank_idx,
                    "standing_points":   None,
                    "standing_wins":     w,
                    "standing_losses":   l,
                    "standing_draws":    None,
                    "standing_gf":       stats.get("pointsFor"),
                    "standing_ga":       stats.get("pointsAgainst"),
                    "standing_gd":       (stats.get("pointsFor") or 0) - (stats.get("pointsAgainst") or 0),
                    "standing_played":   gp,
                    "standing_win_pct":  stats.get("winPercent"),
                    "standing_gb":       stats.get("gamesBehind"),
                    "standing_home_w":   stats.get("homeWins"),
                    "standing_home_l":   stats.get("homeLosses"),
                    "standing_road_w":   stats.get("roadWins"),
                    "standing_road_l":   stats.get("roadLosses"),
                    "standing_streak":   stats.get("streak"),
                })
            else:  # NBA
                w = stats.get("wins", 0) or 0
                l = stats.get("losses", 0) or 0
                row.update({
                    "standing_rank":    stats.get("rank"),
                    "standing_points":  None,
                    "standing_wins":    w,
                    "standing_losses":  l,
                    "standing_draws":   None,
                    "standing_gf":      stats.get("pointsFor"),
                    "standing_ga":      stats.get("pointsAgainst"),
                    "standing_gd":      (stats.get("pointsFor") or 0) - (stats.get("pointsAgainst") or 0),
                    "standing_played":  w + l,
                    "standing_win_pct": stats.get("winPercent"),
                })
            rows.append(row)

    df = pd.DataFrame(rows)
    logger.info("ESPN standings %s: %d teams", league_slug, len(df))
    return df


def fetch_mlb_preseason(season: int = 2026) -> pd.DataFrame:
    """
    Fetch MLB Spring Training standings (Cactus League + Grapefruit League).
    Uses the default seasontype (preseason) for the given season year.
    Returns a DataFrame with the same schema as fetch_espn_standings('mlb').
    """
    url = f"{ESPN_STANDINGS_BASE}/baseball/mlb/standings"
    params = {"season": str(season), "limit": "100"}
    logger.info("Fetching MLB preseason standings season=%s", season)
    data = _get(url, params=params)

    rows: list[dict] = []
    children = data.get("children", [])
    for group in children:
        group_name = group.get("name", "")   # "Cactus League" / "Grapefruit League"
        entries = group.get("standings", {}).get("entries", [])
        for rank_idx, entry in enumerate(entries, start=1):
            team = entry.get("team", {})
            stats = _extract_stats(entry, MLB_STATS)
            w = stats.get("wins", 0) or 0
            l = stats.get("losses", 0) or 0
            gp = stats.get("gamesPlayed") or (w + l) or 0
            row: dict[str, Any] = {
                "league_slug":      "mlb_preseason",
                "group":            group_name,
                "team_name":        team.get("displayName", ""),
                "team_abbr":        team.get("abbreviation", ""),
                "team_logo":        team.get("logos", [{}])[0].get("href", "") if team.get("logos") else "",
                "standing_rank":    rank_idx,
                "standing_points":  None,
                "standing_wins":    w,
                "standing_losses":  l,
                "standing_draws":   None,
                "standing_gf":      stats.get("pointsFor"),
                "standing_ga":      stats.get("pointsAgainst"),
                "standing_gd":      (stats.get("pointsFor") or 0) - (stats.get("pointsAgainst") or 0),
                "standing_played":  gp,
                "standing_win_pct": stats.get("winPercent") or (w / gp if gp else 0),
                "standing_gb":      stats.get("gamesBehind"),
                "standing_home_w":  stats.get("homeWins"),
                "standing_home_l":  stats.get("homeLosses"),
                "standing_road_w":  stats.get("roadWins"),
                "standing_road_l":  stats.get("roadLosses"),
                "standing_streak":  stats.get("streak"),
            }
            rows.append(row)

    df = pd.DataFrame(rows)
    logger.info("MLB preseason standings season=%s: %d teams", season, len(df))
    return df


def fetch_all_standings(delay: float = 0.3) -> pd.DataFrame:
    """Fetch standings for all configured leagues and combine."""
    frames: list[pd.DataFrame] = []
    for slug in ESPN_STANDINGS_LEAGUES:
        try:
            df = fetch_espn_standings(slug)
            frames.append(df)
            time.sleep(delay)
        except Exception as exc:
            logger.warning("Standings fetch failed for %s: %s", slug, exc)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def build_standings_lookup(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """
    Build a lookup keyed by team_name for O(1) feature merging.

    Teams can appear in multiple leagues (e.g. Arsenal in both EPL and UCL).
    We store both a league-specific key "{team}|{league}" AND a generic "{team}" key
    (the domestic league row, identified by being EPL/Bundesliga/LaLiga/Liga MX/NBA/MLB).

    Callers that know the league should look up "{team}|{league}" first, then fall back
    to "{team}" for domestic context.

    Returns:
        {
          "Arsenal":      {"standing_rank": 3, ...},   # EPL row (domestic)
          "Arsenal|UCL":  {"standing_rank": 1, ...},   # UCL row
          "Arsenal|EPL":  {"standing_rank": 3, ...},   # EPL row again
        }
    """
    DOMESTIC_LEAGUES = {"epl", "bundesliga", "laliga", "liga_mx", "nba", "mlb"}
    lookup: dict[str, dict[str, Any]] = {}

    for _, row in df.iterrows():
        name   = row.get("team_name", "")
        league = str(row.get("league_slug", row.get("league", ""))).lower()
        d      = row.to_dict()

        # Always store league-specific key
        lookup[f"{name}|{league}"] = d

        # Generic key: prefer domestic league; don't overwrite with UCL/Europa
        if name not in lookup or league in DOMESTIC_LEAGUES:
            lookup[name] = d

    return lookup


# ---------------------------------------------------------------------------
# TheSportsDB — team metadata (logos, colours)
# ---------------------------------------------------------------------------

TSDB_BASE = "https://www.thesportsdb.com/api/v1/json/3"

# Cache to avoid re-fetching the same team name
_tsdb_cache: dict[str, dict] = {}


def fetch_team_meta(team_name: str) -> dict[str, str]:
    """
    Fetch team logo URL, badge colour, and founded year from TheSportsDB.

    Returns a dict with keys: logo_url, badge_colour, founded_year, country.
    Empty strings on failure.
    """
    if team_name in _tsdb_cache:
        return _tsdb_cache[team_name]

    empty = {"logo_url": "", "badge_colour": "", "founded_year": "", "country": ""}
    try:
        r = _SESSION.get(f"{TSDB_BASE}/searchteams.php", params={"t": team_name}, timeout=10)
        r.raise_for_status()
        teams = r.json().get("teams") or []
        if not teams:
            _tsdb_cache[team_name] = empty
            return empty
        t = teams[0]
        result = {
            "logo_url":     t.get("strThumb") or t.get("strTeamBadge") or "",
            "badge_colour": t.get("strColour1") or "",
            "founded_year": t.get("intFormedYear") or "",
            "country":      t.get("strCountry") or "",
        }
        _tsdb_cache[team_name] = result
        return result
    except Exception as exc:
        logger.warning("TheSportsDB lookup failed for '%s': %s", team_name, exc)
        _tsdb_cache[team_name] = empty
        return empty


def fetch_teams_meta_bulk(team_names: list[str], delay: float = 0.3) -> pd.DataFrame:
    """
    Fetch metadata for a list of team names.
    Returns DataFrame with columns: team_name, logo_url, badge_colour, founded_year, country.
    """
    rows = []
    for name in team_names:
        meta = fetch_team_meta(name)
        rows.append({"team_name": name, **meta})
        time.sleep(delay)
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# OpenLigaDB — Bundesliga historical match data (supplement)
# ---------------------------------------------------------------------------

OPENLIGA_BASE = "https://api.openligadb.de"

# Bundesliga league shortcut + available seasons
BL1_SEASONS = list(range(2016, 2026))   # 2016/17 through 2024/25


def fetch_openligadb_matchday(season: int, matchday: int) -> list[dict]:
    """
    Fetch one Bundesliga matchday from OpenLigaDB and normalise to game schema.

    Parameters
    ----------
    season : int
        Season start year (e.g. 2023 = 2023/24 season).
    matchday : int
        Matchday number (1-34).
    """
    url = f"{OPENLIGA_BASE}/getmatchdata/bl1/{season}/{matchday}"
    try:
        r = _SESSION.get(url, timeout=12)
        r.raise_for_status()
        matches = r.json()
    except Exception as exc:
        logger.warning("OpenLigaDB %s/%s error: %s", season, matchday, exc)
        return []

    rows = []
    for m in matches:
        results = m.get("matchResults", [])
        # matchResults: [{resultTypeID:1, pointsTeam1, pointsTeam2}, {resultTypeID:2, ...}]
        # resultTypeID=2 is final score
        final = next((r for r in results if r.get("resultTypeID") == 2), None)
        if not final:
            continue   # match not yet played

        team1 = m.get("team1", {})
        team2 = m.get("team2", {})

        row: dict[str, Any] = {
            "date":       m.get("matchDateTime", ""),
            "league":     "Bundesliga",
            "sport":      "soccer",
            "home_team":  team1.get("teamName", ""),
            "away_team":  team2.get("teamName", ""),
            "home_score": final.get("pointsTeam1", 0),
            "away_score": final.get("pointsTeam2", 0),
            "status":     "STATUS_FINAL",
            "venue":      m.get("location", {}).get("locationCity", "") if m.get("location") else "",
            "home_odds":  None,
            "away_odds":  None,
            "draw_odds":  None,
            "total_line": None,
            "over_odds":  None,
            "under_odds": None,
        }
        # Try to extract odds from OpenLigaDB goals (they sometimes embed odds in matchday data)
        for goal in m.get("goals", []):
            pass  # no odds in this API

        rows.append(row)
    return rows


def fetch_openligadb_season(season: int, delay: float = 0.4) -> pd.DataFrame:
    """Fetch all 34 matchdays for a Bundesliga season."""
    all_rows: list[dict] = []
    for md in range(1, 35):
        rows = fetch_openligadb_matchday(season, md)
        all_rows.extend(rows)
        time.sleep(delay)

    df = pd.DataFrame(all_rows)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], utc=True, errors="coerce")
    return df.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)


def fetch_openligadb_historical(seasons: list[int] | None = None, delay: float = 0.4) -> pd.DataFrame:
    """
    Fetch multiple Bundesliga seasons from OpenLigaDB.

    Default seasons: 2016 through 2024 (9 seasons × ~306 games = ~2,754 rows).
    """
    if seasons is None:
        seasons = BL1_SEASONS

    frames: list[pd.DataFrame] = []
    for s in seasons:
        logger.info("OpenLigaDB: fetching Bundesliga season %d/%d", s, s + 1)
        df = fetch_openligadb_season(s, delay=delay)
        if not df.empty:
            frames.append(df)

    if not frames:
        return pd.DataFrame()
    combined = pd.concat(frames, ignore_index=True)
    combined = combined.drop_duplicates(subset=["date", "home_team", "away_team"])
    return combined.sort_values("date").reset_index(drop=True)
