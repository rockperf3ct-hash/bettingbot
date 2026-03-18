from __future__ import annotations

import os

import pandas as pd

from sports_model.context import utc_now_iso
from sports_model.config import settings
from sports_model.data_sources import fetch_news_sentiment_seed, fetch_openweather
from sports_model.datasets import enrich_games_with_context, save_odds_snapshot
from sports_model.pipeline import full_run


def fetch_news_for_teams(teams: list[str], out_path: str) -> str:
    records: list[dict] = []
    for team in teams:
        try:
            payload = fetch_news_sentiment_seed(team)
        except Exception as exc:
            print(f"news_fetch_failed team={team} error={exc}")
            continue
        for article in payload.get("articles", []):
            records.append(
                {
                    "team": team,
                    "publishedAt": article.get("publishedAt"),
                    "title": article.get("title"),
                    "description": article.get("description"),
                    "source": (article.get("source") or {}).get("name"),
                }
            )

    df = pd.DataFrame(records)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    df.to_csv(out_path, index=False)
    return out_path


def fetch_weather_for_teams(team_city_map_path: str, out_path: str) -> str:
    teams = pd.read_csv(team_city_map_path)
    records: list[dict] = []

    for _, row in teams.iterrows():
        team = str(row.get("team", ""))
        city = str(row.get("city", ""))
        country = str(row.get("country_code", ""))
        try:
            payload = fetch_openweather(city=city, country_code=country if country else None)
        except Exception as exc:
            print(f"weather_fetch_failed team={team} city={city} error={exc}")
            continue
        main = payload.get("main", {})
        wind = payload.get("wind", {})
        records.append(
            {
                "home_team": team,
                "as_of": utc_now_iso(),
                "weather_temp_c": main.get("temp"),
                "weather_wind_kph": (wind.get("speed") or 0) * 3.6,
                "city": city,
                "country_code": country,
            }
        )

    df = pd.DataFrame(records)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    df.to_csv(out_path, index=False)
    return out_path


def run_daily_pipeline(
    games_path: str,
    enriched_out_path: str,
    artifacts_dir: str,
    sport_key: str,
    odds_snapshots_path: str,
    teams: list[str] | None = None,
    team_city_map_path: str | None = None,
    injuries_path: str | None = None,
    news_out_path: str | None = None,
    weather_out_path: str | None = None,
) -> dict:
    save_odds_snapshot(
        sport_key=sport_key,
        out_path=odds_snapshots_path,
        region=settings.odds_region,
        market=settings.odds_market,
    )

    news_path = news_out_path
    if teams and news_out_path:
        news_path = fetch_news_for_teams(teams, news_out_path)

    wx_path = weather_out_path
    if team_city_map_path and weather_out_path:
        wx_path = fetch_weather_for_teams(team_city_map_path=team_city_map_path, out_path=weather_out_path)

    enrich_games_with_context(
        games_path=games_path,
        out_path=enriched_out_path,
        injuries_path=injuries_path,
        news_path=news_path,
        weather_path=wx_path,
        line_snapshots_path=odds_snapshots_path,
    )

    return full_run(data_path=enriched_out_path, out_dir=artifacts_dir)
