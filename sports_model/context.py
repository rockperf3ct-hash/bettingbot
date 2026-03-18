from __future__ import annotations

from datetime import datetime

import numpy as np
import pandas as pd


POSITIVE_WORDS = {
    "win",
    "healthy",
    "fit",
    "dominant",
    "strong",
    "momentum",
    "improved",
    "returns",
}

NEGATIVE_WORDS = {
    "injury",
    "injured",
    "out",
    "suspended",
    "fatigue",
    "doubtful",
    "struggle",
    "poor",
    "loss",
}


def naive_sentiment_score(text: str) -> float:
    words = text.lower().split()
    pos = sum(w.strip(".,!?;:") in POSITIVE_WORDS for w in words)
    neg = sum(w.strip(".,!?;:") in NEGATIVE_WORDS for w in words)
    total = max(1, pos + neg)
    return float((pos - neg) / total)


def news_to_team_sentiment(news_df: pd.DataFrame, as_of_col: str = "publishedAt") -> pd.DataFrame:
    if news_df.empty:
        return pd.DataFrame(columns=["team", "as_of", "sentiment"])

    work = news_df.copy()
    work[as_of_col] = pd.to_datetime(work[as_of_col], utc=True, errors="coerce")
    work = work[work[as_of_col].notna()]
    if "team" not in work.columns:
        work["team"] = "unknown"

    title = work["title"].fillna("") if "title" in work.columns else ""
    desc = work["description"].fillna("") if "description" in work.columns else ""
    combined = (title + " " + desc).astype(str)
    work["sentiment"] = combined.map(naive_sentiment_score)
    work["as_of"] = work[as_of_col]

    return work[["team", "as_of", "sentiment"]].sort_values("as_of").reset_index(drop=True)


def add_point_in_time_context(
    games: pd.DataFrame,
    injuries: pd.DataFrame | None = None,
    team_sentiment: pd.DataFrame | None = None,
    weather: pd.DataFrame | None = None,
) -> pd.DataFrame:
    out = games.copy()
    out["date"] = pd.to_datetime(out["date"], utc=True)

    if injuries is not None and not injuries.empty:
        inj = injuries.copy()
        inj["as_of"] = pd.to_datetime(inj["as_of"], utc=True)
        inj = inj.sort_values("as_of")
        home = pd.merge_asof(
            out.sort_values("date"),
            inj.rename(columns={"team": "home_team", "impact": "injury_impact_home"}).sort_values("as_of"),
            left_on="date",
            right_on="as_of",
            by="home_team",
            direction="backward",
        )
        out = home.drop(columns=["as_of"], errors="ignore")
        away = pd.merge_asof(
            out.sort_values("date"),
            inj.rename(columns={"team": "away_team", "impact": "injury_impact_away"}).sort_values("as_of"),
            left_on="date",
            right_on="as_of",
            by="away_team",
            direction="backward",
        )
        out = away.drop(columns=["as_of"], errors="ignore")

    if team_sentiment is not None and not team_sentiment.empty:
        sent = team_sentiment.copy()
        sent["as_of"] = pd.to_datetime(sent["as_of"], utc=True)
        sent = sent.sort_values("as_of")
        home = pd.merge_asof(
            out.sort_values("date"),
            sent.rename(columns={"team": "home_team", "sentiment": "sentiment_home"}).sort_values("as_of"),
            left_on="date",
            right_on="as_of",
            by="home_team",
            direction="backward",
        )
        out = home.drop(columns=["as_of"], errors="ignore")
        away = pd.merge_asof(
            out.sort_values("date"),
            sent.rename(columns={"team": "away_team", "sentiment": "sentiment_away"}).sort_values("as_of"),
            left_on="date",
            right_on="as_of",
            by="away_team",
            direction="backward",
        )
        out = away.drop(columns=["as_of"], errors="ignore")

    if weather is not None and not weather.empty:
        wx = weather.copy()
        wx["as_of"] = pd.to_datetime(wx["as_of"], utc=True)
        wx = wx.sort_values("as_of")
        out = pd.merge_asof(
            out.sort_values("date"),
            wx.sort_values("as_of"),
            left_on="date",
            right_on="as_of",
            by="home_team",
            direction="backward",
        ).drop(columns=["as_of"], errors="ignore")

    fill_defaults = {
        "injury_impact_home": 0.0,
        "injury_impact_away": 0.0,
        "sentiment_home": 0.0,
        "sentiment_away": 0.0,
        "weather_temp_c": 18.0,
        "weather_wind_kph": 10.0,
    }

    for col, default in fill_defaults.items():
        if col not in out.columns:
            out[col] = default
        out[col] = out[col].fillna(default)

    out = out.sort_values("date").reset_index(drop=True)
    return out


def utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def add_rest_days(games: pd.DataFrame) -> pd.DataFrame:
    out = games.copy()
    out["date"] = pd.to_datetime(out["date"], utc=True)
    out = out.sort_values("date").reset_index(drop=True)

    last_seen: dict[str, pd.Timestamp] = {}
    home_rest: list[float] = []
    away_rest: list[float] = []

    for _, row in out.iterrows():
        date = row["date"]
        home = row["home_team"]
        away = row["away_team"]

        home_days = 3.0
        away_days = 3.0
        if home in last_seen:
            home_days = max(0.0, (date - last_seen[home]).total_seconds() / 86400.0)
        if away in last_seen:
            away_days = max(0.0, (date - last_seen[away]).total_seconds() / 86400.0)

        home_rest.append(float(home_days))
        away_rest.append(float(away_days))

        last_seen[home] = date
        last_seen[away] = date

    out["home_rest_days"] = np.round(home_rest, 2)
    out["away_rest_days"] = np.round(away_rest, 2)
    out["is_b2b_home"] = (out["home_rest_days"] <= 1.1).astype(int)
    out["is_b2b_away"] = (out["away_rest_days"] <= 1.1).astype(int)
    return out
