from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import pandas as pd
import requests

from sports_model.config import settings


@dataclass
class APIClient:
    base_url: str
    headers: dict[str, str]

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self.base_url.rstrip('/')}/{path.lstrip('/')}"
        response = requests.get(url, params=params or {}, headers=self.headers, timeout=30)
        response.raise_for_status()
        return response.json()


def api_football_client() -> APIClient:
    return APIClient(
        base_url="https://v3.football.api-sports.io",
        headers={"x-apisports-key": settings.api_football_key},
    )


def the_odds_api_client() -> APIClient:
    return APIClient(
        base_url="https://api.the-odds-api.com/v4",
        headers={},
    )


def news_api_client() -> APIClient:
    return APIClient(
        base_url="https://newsdata.io/api/1",
        headers={},
    )


def fetch_odds_snapshot(sport_key: str, region: str = "us", market: str = "h2h") -> Any:
    if not settings.the_odds_api_key:
        raise ValueError("THE_ODDS_API_KEY is missing")
    client = the_odds_api_client()
    path = f"sports/{sport_key}/odds"
    return client.get(path, params={"apiKey": settings.the_odds_api_key, "regions": region, "markets": market})


def fetch_odds_historical_snapshot(
    sport_key: str,
    iso_timestamp: str,
    region: str = "us",
    market: str = "h2h",
) -> Any:
    if not settings.the_odds_api_key:
        raise ValueError("THE_ODDS_API_KEY is missing")
    client = the_odds_api_client()
    path = f"historical/sports/{sport_key}/odds"
    return client.get(
        path,
        params={
            "apiKey": settings.the_odds_api_key,
            "regions": region,
            "markets": market,
            "date": iso_timestamp,
        },
    )


def normalize_the_odds_snapshot(payload: Any, captured_at: str | None = None) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    snap_ts = captured_at or datetime.now(tz=timezone.utc).isoformat()
    if isinstance(payload, list):
        games = payload
    else:
        games = payload.get("data", payload)
    if not isinstance(games, list):
        return pd.DataFrame()

    for game in games:
        if not isinstance(game, dict):
            continue
        event_id = game.get("id")
        sport_key = game.get("sport_key")
        commence_time = game.get("commence_time")
        home_team = game.get("home_team")
        away_team = game.get("away_team")

        for book in game.get("bookmakers", []) or []:
            if not isinstance(book, dict):
                continue
            bookmaker = book.get("key")
            for market in book.get("markets", []) or []:
                if not isinstance(market, dict):
                    continue
                market_key = market.get("key")
                for outcome in market.get("outcomes", []) or []:
                    if not isinstance(outcome, dict):
                        continue
                    records.append(
                        {
                            "captured_at": snap_ts,
                            "event_id": event_id,
                            "sport_key": sport_key,
                            "commence_time": commence_time,
                            "home_team": home_team,
                            "away_team": away_team,
                            "bookmaker": bookmaker,
                            "market": market_key,
                            "outcome_name": outcome.get("name"),
                            "price": outcome.get("price"),
                            "point": outcome.get("point"),
                        }
                    )

    return pd.DataFrame(records)


def fetch_news_sentiment_seed(query: str) -> dict[str, Any]:
    if not settings.news_api_key:
        raise ValueError("NEWS_API_KEY is missing")
    client = news_api_client()
    payload = client.get(
        "news",
        params={
            "apikey": settings.news_api_key,
            "q": query,
            "language": "en",
        },
    )

    if not isinstance(payload, dict):
        return {"articles": []}

    results = payload.get("results", [])
    if not isinstance(results, list):
        return {"articles": []}

    normalized = []
    for item in results:
        if not isinstance(item, dict):
            continue
        normalized.append(
            {
                "publishedAt": item.get("pubDate"),
                "title": item.get("title"),
                "description": item.get("description"),
                "source": {"name": item.get("source_name")},
            }
        )

    return {"articles": normalized}


def fetch_news_sentiment(team: str, days: int = 3) -> list[dict]:
    """
    Fetch recent news for a team and return articles with a naive sentiment score.
    Sentiment: +1 positive keywords, -1 negative, 0 neutral.
    """
    POSITIVE = {"win", "wins", "victory", "beat", "dominant", "strong", "form",
                "impressive", "return", "healthy", "fit", "scored", "goal"}
    NEGATIVE = {"loss", "loses", "lose", "injured", "injury", "suspend", "out",
                "miss", "crisis", "struggle", "weak", "defeat", "poor"}

    try:
        raw = fetch_news_sentiment_seed(team)
    except Exception:
        return []

    results = []
    for a in raw.get("articles", [])[:10]:
        title = (a.get("title") or "").lower()
        desc  = (a.get("description") or "").lower()
        text  = title + " " + desc
        words = set(text.split())
        pos = len(words & POSITIVE)
        neg = len(words & NEGATIVE)
        score = (pos - neg) / max(pos + neg, 1) if (pos + neg) > 0 else 0.0
        results.append({
            "title":       a.get("title", ""),
            "description": a.get("description", ""),
            "publishedAt": a.get("publishedAt", ""),
            "source":      (a.get("source") or {}).get("name", ""),
            "sentiment":   round(score, 2),
            "sentiment_label": "positive" if score > 0.1 else ("negative" if score < -0.1 else "neutral"),
        })
    return results


def fetch_openweather(city: str, country_code: str | None = None) -> dict[str, Any]:
    if not settings.openweather_api_key:
        raise ValueError("OPENWEATHER_API_KEY is missing")
    query = city if not country_code else f"{city},{country_code}"
    client = APIClient(base_url="https://api.openweathermap.org/data/2.5", headers={})
    return client.get("weather", params={"q": query, "appid": settings.openweather_api_key, "units": "metric"})


def fetch_reddit_posts(subreddit: str, query: str, limit: int = 50) -> dict[str, Any]:
    auth = (settings.reddit_client_id, settings.reddit_client_secret)
    headers = {"User-Agent": settings.reddit_user_agent}
    token_resp = requests.post(
        "https://www.reddit.com/api/v1/access_token",
        auth=auth,
        data={"grant_type": "client_credentials"},
        headers=headers,
        timeout=30,
    )
    token_resp.raise_for_status()
    token = token_resp.json().get("access_token")
    if not token:
        raise ValueError("Failed to retrieve Reddit access token")

    search_headers = {"Authorization": f"bearer {token}", "User-Agent": settings.reddit_user_agent}
    url = f"https://oauth.reddit.com/r/{subreddit}/search"
    resp = requests.get(url, params={"q": query, "restrict_sr": 1, "sort": "new", "limit": limit}, headers=search_headers, timeout=30)
    resp.raise_for_status()
    return resp.json()
