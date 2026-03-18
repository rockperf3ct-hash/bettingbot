"""
MLB Historical Ingest — MLB Stats API (free, no key required)

Fetches completed regular-season games for 2019-2024, normalised to the
project's historical_games schema.  Includes:
  - Final score (runs), hits, errors per team
  - Starting pitcher names (home + away)
  - Day/night flag, venue

Rolling pitcher ERA is computed downstream in features.py from
the game results we ingest here — no extra API calls needed.

Usage (standalone):
    python -m sports_model.mlb_historical_ingest

Or import and call:
    from sports_model.mlb_historical_ingest import ingest_mlb_seasons, merge_into_historical
"""

from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from typing import Any

import pandas as pd
import requests

logger = logging.getLogger(__name__)

MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1"

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "sports-model/1.0 (educational)"})


# Seasons to ingest  (skip 2020 — 60-game COVID season, unreliable signals)
DEFAULT_SEASONS = [2019, 2021, 2022, 2023, 2024]


# ---------------------------------------------------------------------------
# Fetch helpers
# ---------------------------------------------------------------------------

def _fetch_week(start: date, end: date, retries: int = 3) -> list[dict]:
    """
    Fetch all completed regular-season games in a date window.
    Returns list of raw game dicts from MLB Stats API.
    """
    params = {
        "sportId":   "1",
        "startDate": start.isoformat(),
        "endDate":   end.isoformat(),
        "gameType":  "R",
        "hydrate":   "linescore,probablePitcher,team",
        "limit":     "200",
    }
    for attempt in range(retries):
        try:
            r = _SESSION.get(f"{MLB_STATS_BASE}/schedule", params=params, timeout=20)
            r.raise_for_status()
            data = r.json()
            games: list[dict] = []
            for day in data.get("dates", []):
                for g in day.get("games", []):
                    games.append(g)
            return games
        except Exception as exc:
            logger.warning("Attempt %d failed (%s-%s): %s", attempt + 1, start, end, exc)
            time.sleep(2 ** attempt)
    return []


def _parse_game(g: dict) -> dict | None:
    """
    Normalise one MLB Stats API game record to the project schema.
    Returns None if the game is not final / has no score.
    """
    status = g.get("status", {}).get("detailedState", "")
    if status not in ("Final", "Completed Early", "Game Over"):
        return None

    teams = g.get("teams", {})
    home  = teams.get("home", {})
    away  = teams.get("away", {})

    home_score = home.get("score")
    away_score = away.get("score")
    if home_score is None or away_score is None:
        return None

    ls   = g.get("linescore", {}).get("teams", {})
    ls_h = ls.get("home", {})
    ls_a = ls.get("away", {})

    home_sp = home.get("probablePitcher", {}).get("fullName", "")
    away_sp = away.get("probablePitcher", {}).get("fullName", "")

    venue = g.get("venue", {}).get("name", "")
    game_date = g.get("officialDate") or g.get("gameDate", "")[:10]

    return {
        "date":          game_date + "T19:00:00+00:00",  # approximate time — only date matters
        "league":        "MLB",
        "sport":         "baseball",
        "home_team":     home.get("team", {}).get("name", ""),
        "away_team":     away.get("team", {}).get("name", ""),
        "home_score":    int(home_score),
        "away_score":    int(away_score),
        "home_odds":     None,
        "away_odds":     None,
        "draw_odds":     None,
        "total_line":    None,
        "over_odds":     None,
        "under_odds":    None,
        "home_hits":     ls_h.get("hits"),
        "away_hits":     ls_a.get("hits"),
        "home_errors":   ls_h.get("errors"),
        "away_errors":   ls_a.get("errors"),
        "home_left_on_base": ls_h.get("leftOnBase"),
        "away_left_on_base": ls_a.get("leftOnBase"),
        "winning_pitcher": home_sp if int(home_score) > int(away_score) else away_sp,
        "losing_pitcher":  away_sp if int(home_score) > int(away_score) else home_sp,
        "home_sp":       home_sp,   # starting pitcher (pre-game feature)
        "away_sp":       away_sp,
        "venue":         venue,
        "status":        "STATUS_FINAL",
        # Placeholders (will be filled by features.py)
        "home_rest_days":       None,
        "away_rest_days":       None,
        "travel_km_diff":       0.0,
        "is_b2b_home":          None,
        "is_b2b_away":          None,
        "injury_impact_home":   0.0,
        "injury_impact_away":   0.0,
        "sentiment_home":       0.0,
        "sentiment_away":       0.0,
        "weather_temp_c":       18.0,
        "weather_wind_kph":     10.0,
        "closing_home_odds":    None,
        "closing_away_odds":    None,
        "home_form_rate":       None,
        "away_form_rate":       None,
        "home_form_str":        None,
        "away_form_str":        None,
    }


# ---------------------------------------------------------------------------
# Season ingestion
# ---------------------------------------------------------------------------

def ingest_season(year: int, delay: float = 0.25) -> pd.DataFrame:
    """
    Fetch all completed regular-season games for one MLB season.
    Fetches in weekly windows to stay well within rate limits.
    """
    # MLB regular season: late March/early April → late September/early October
    season_start = date(year, 3, 20)
    season_end   = date(year, 10, 10)

    rows: list[dict] = []
    current = season_start
    week_count = 0

    while current <= season_end:
        week_end = min(current + timedelta(days=6), season_end)
        games = _fetch_week(current, week_end)

        for g in games:
            parsed = _parse_game(g)
            if parsed:
                rows.append(parsed)

        week_count += 1
        if week_count % 4 == 0:
            logger.info("  Season %d: fetched through %s (%d games so far)", year, week_end, len(rows))

        current = week_end + timedelta(days=1)
        time.sleep(delay)

    df = pd.DataFrame(rows)
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"], utc=True, format="mixed")
        df = df.drop_duplicates(subset=["date", "home_team", "away_team"])
        df = df.sort_values("date").reset_index(drop=True)

    logger.info("Season %d: %d games ingested", year, len(df))
    return df


def ingest_mlb_seasons(
    seasons: list[int] | None = None,
    delay: float = 0.25,
) -> pd.DataFrame:
    """
    Ingest multiple MLB seasons and return a combined DataFrame.
    Default seasons: 2019, 2021, 2022, 2023, 2024 (skip 2020 COVID).
    """
    if seasons is None:
        seasons = DEFAULT_SEASONS

    frames: list[pd.DataFrame] = []
    for year in seasons:
        logger.info("Ingesting MLB season %d…", year)
        df = ingest_season(year, delay=delay)
        if not df.empty:
            frames.append(df)
        time.sleep(1.0)  # pause between seasons

    if not frames:
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    combined = combined.drop_duplicates(subset=["date", "home_team", "away_team"])
    combined = combined.sort_values("date").reset_index(drop=True)
    return combined


# ---------------------------------------------------------------------------
# Pitcher rolling ERA feature
# ---------------------------------------------------------------------------

def add_rolling_pitcher_era(df: pd.DataFrame, window: int = 10) -> pd.DataFrame:
    """
    Compute rolling ERA proxy for each starting pitcher from ingested game data.

    For each game, looks back at the pitcher's last `window` starts and computes:
      - Earned runs allowed per 9 innings (ERA proxy — using runs as proxy since
        earned runs not available from linescore)
      - Innings pitched average (proxy for durability)
      - Win rate over last N starts

    These are point-in-time (shifted by 1 start) — no lookahead.

    Adds columns: home_sp_era_proxy, away_sp_era_proxy, home_sp_win_rate, away_sp_win_rate
    """
    if df.empty or "home_sp" not in df.columns:
        df["home_sp_era_proxy"] = 0.0
        df["away_sp_era_proxy"] = 0.0
        df["home_sp_win_rate"]  = 0.5
        df["away_sp_win_rate"]  = 0.5
        df["sp_era_diff"]       = 0.0
        df["sp_winrate_diff"]   = 0.0
        return df

    df = df.sort_values("date").reset_index(drop=True)

    # Build per-pitcher appearance records
    # A pitcher's "allowed" = the runs scored by the opponent when they started
    pitcher_records: dict[str, list[dict]] = {}

    home_era: list[float] = []
    away_era: list[float] = []
    home_wr:  list[float] = []
    away_wr:  list[float] = []

    for _, row in df.iterrows():
        hsp = str(row.get("home_sp") or "").strip()
        asp = str(row.get("away_sp") or "").strip()

        def get_pitcher_stats(name: str) -> tuple[float, float]:
            """Returns (era_proxy, win_rate) from last window starts."""
            if not name or name == "nan":
                return 4.50, 0.5   # league average defaults
            records = pitcher_records.get(name, [])
            if not records:
                return 4.50, 0.5
            recent = records[-window:]
            era = float(pd.Series([r["runs_allowed"] for r in recent]).mean()) * 9.0 / 6.0
            wr  = float(pd.Series([r["won"] for r in recent]).mean())
            return round(era, 3), round(wr, 3)

        h_era, h_wr = get_pitcher_stats(hsp)
        a_era, a_wr = get_pitcher_stats(asp)

        home_era.append(h_era)
        away_era.append(a_era)
        home_wr.append(h_wr)
        away_wr.append(a_wr)

        # NOW update records with this game's result (point-in-time: recorded after)
        hs, as_ = int(row.get("home_score", 0) or 0), int(row.get("away_score", 0) or 0)

        if hsp and hsp != "nan":
            if hsp not in pitcher_records:
                pitcher_records[hsp] = []
            pitcher_records[hsp].append({
                "runs_allowed": as_,   # away scored against home pitcher
                "won": 1 if hs > as_ else 0,
            })

        if asp and asp != "nan":
            if asp not in pitcher_records:
                pitcher_records[asp] = []
            pitcher_records[asp].append({
                "runs_allowed": hs,   # home scored against away pitcher
                "won": 1 if as_ > hs else 0,
            })

    df["home_sp_era_proxy"] = home_era
    df["away_sp_era_proxy"] = away_era
    df["home_sp_win_rate"]  = home_wr
    df["away_sp_win_rate"]  = away_wr
    # Differential features (positive = home pitcher advantage)
    df["sp_era_diff"]     = df["away_sp_era_proxy"] - df["home_sp_era_proxy"]   # higher = home pitcher better
    df["sp_winrate_diff"] = df["home_sp_win_rate"]  - df["away_sp_win_rate"]

    return df


# ---------------------------------------------------------------------------
# Merge into historical_games.csv
# ---------------------------------------------------------------------------

def merge_into_historical(
    new_df: pd.DataFrame,
    hist_path: str = "data/historical_games.csv",
    out_path:  str | None = None,
) -> pd.DataFrame:
    """
    Merge newly ingested MLB games into the existing historical_games.csv.
    Deduplicates by (date, home_team, away_team).
    Writes back to hist_path (or out_path if specified).
    """
    if out_path is None:
        out_path = hist_path

    existing = pd.read_csv(hist_path)
    existing["date"] = pd.to_datetime(existing["date"], utc=True, format="mixed")

    if new_df.empty:
        logger.warning("No new games to merge.")
        return existing

    # Align columns — add missing cols to new_df with None
    for col in existing.columns:
        if col not in new_df.columns:
            new_df[col] = None

    # Ensure date column is timezone-aware
    new_df["date"] = pd.to_datetime(new_df["date"], utc=True, format="mixed")

    combined = pd.concat([existing, new_df[existing.columns]], ignore_index=True)
    combined = combined.drop_duplicates(subset=["date", "home_team", "away_team"])
    combined = combined.sort_values("date").reset_index(drop=True)

    combined.to_csv(out_path, index=False)
    logger.info("Merged: %d existing + %d new = %d total rows → %s",
                len(existing), len(new_df), len(combined), out_path)
    return combined


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    import os
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    seasons = DEFAULT_SEASONS
    if len(sys.argv) > 1:
        seasons = [int(s) for s in sys.argv[1:]]

    logger.info("Ingesting MLB seasons: %s", seasons)
    df = ingest_mlb_seasons(seasons=seasons)

    if df.empty:
        logger.error("No games ingested. Exiting.")
        sys.exit(1)

    logger.info("Adding rolling pitcher ERA features…")
    df = add_rolling_pitcher_era(df)

    # Save raw ingested data
    raw_path = "data/mlb_ingested_raw.csv"
    df.to_csv(raw_path, index=False)
    logger.info("Raw data saved to %s (%d rows)", raw_path, len(df))

    # Merge into historical
    merged = merge_into_historical(df, hist_path="data/historical_games.csv")

    by_year = merged[merged["sport"] == "baseball"].copy()
    by_year["year"] = by_year["date"].astype(str).str[:4]
    logger.info("MLB rows by year:\n%s", by_year.groupby("year").size().to_string())
