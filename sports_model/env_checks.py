from __future__ import annotations

from sports_model.config import settings


def env_report() -> dict:
    return {
        "THE_ODDS_API_KEY": bool(settings.the_odds_api_key),
        "NEWS_API_KEY": bool(settings.news_api_key),
        "OPENWEATHER_API_KEY": bool(settings.openweather_api_key),
        "REDDIT_CLIENT_ID": bool(settings.reddit_client_id),
        "REDDIT_CLIENT_SECRET": bool(settings.reddit_client_secret),
    }


def has_odds_access() -> bool:
    return bool(settings.the_odds_api_key)


def has_context_access() -> bool:
    return bool(settings.news_api_key) and bool(settings.openweather_api_key)
