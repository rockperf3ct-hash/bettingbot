from __future__ import annotations

import os

import pandas as pd
from pandas.errors import EmptyDataError

from sports_model.context import add_point_in_time_context, add_rest_days, news_to_team_sentiment, utc_now_iso
from sports_model.data_sources import (
    fetch_odds_historical_snapshot,
    fetch_odds_snapshot,
    normalize_the_odds_snapshot,
)
from sports_model.odds import attach_closing_odds, derive_open_mid_close


def save_odds_snapshot(
    sport_key: str,
    out_path: str,
    region: str,
    market: str,
    historical_iso_date: str | None = None,
) -> str:
    if historical_iso_date:
        payload = fetch_odds_historical_snapshot(
            sport_key=sport_key,
            iso_timestamp=historical_iso_date,
            region=region,
            market=market,
        )
        captured_at = historical_iso_date
    else:
        payload = fetch_odds_snapshot(sport_key=sport_key, region=region, market=market)
        captured_at = utc_now_iso()

    odds = normalize_the_odds_snapshot(payload, captured_at=captured_at)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    if os.path.exists(out_path):
        prev = pd.read_csv(out_path)
        odds = pd.concat([prev, odds], ignore_index=True)
        odds = odds.drop_duplicates(
            subset=["captured_at", "event_id", "bookmaker", "market", "outcome_name"],
            keep="last",
        )

    odds.sort_values(["captured_at", "event_id"], inplace=True)
    odds.to_csv(out_path, index=False)
    return out_path


def enrich_games_with_context(
    games_path: str,
    out_path: str,
    injuries_path: str | None = None,
    news_path: str | None = None,
    weather_path: str | None = None,
    line_snapshots_path: str | None = None,
) -> str:
    def _safe_read_csv(path: str | None) -> pd.DataFrame | None:
        if not path:
            return None
        if not os.path.exists(path):
            return None
        try:
            return pd.read_csv(path)
        except EmptyDataError:
            return None

    games = pd.read_csv(games_path)
    games = add_rest_days(games)

    injuries = _safe_read_csv(injuries_path)

    sentiment = None
    news = _safe_read_csv(news_path)
    if news is not None:
        sentiment = news_to_team_sentiment(news)

    weather = _safe_read_csv(weather_path)

    enriched = add_point_in_time_context(games, injuries=injuries, team_sentiment=sentiment, weather=weather)

    if line_snapshots_path:
        lines = _safe_read_csv(line_snapshots_path)
        if lines is not None:
            line_summary = derive_open_mid_close(lines)
            enriched = attach_closing_odds(enriched, line_summary)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    enriched.to_csv(out_path, index=False)
    return out_path
