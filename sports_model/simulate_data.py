from __future__ import annotations

import os

import numpy as np
import pandas as pd


def generate_sample_data(rows: int = 2000, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)

    teams = [f"Team_{i:02d}" for i in range(1, 31)]
    leagues = ["league_a", "league_b", "league_c"]

    start = pd.Timestamp("2021-01-01", tz="UTC")
    dates = [start + pd.Timedelta(hours=12 * i) for i in range(rows)]

    base_strength = {team: rng.normal(0.0, 1.0) for team in teams}
    records = []

    for i in range(rows):
        home, away = rng.choice(teams, size=2, replace=False)
        league = rng.choice(leagues)

        strength_diff = base_strength[home] - base_strength[away]
        rest_diff = rng.normal(0.0, 1.5)
        injury_diff = rng.normal(0.0, 0.7)
        sentiment_diff = rng.normal(0.0, 0.5)
        travel_km_diff = rng.normal(0.0, 250.0)
        weather_temp_c = float(rng.normal(18.0, 8.0))
        weather_wind_kph = float(max(0.0, rng.normal(12.0, 6.0)))

        latent = 0.35 * strength_diff + 0.15 * rest_diff - 0.18 * injury_diff + 0.08 * sentiment_diff + 0.05
        p_home_win = 1.0 / (1.0 + np.exp(-latent))

        home_win = rng.random() < p_home_win
        home_score = int(max(0, rng.normal(2.1 + 0.4 * p_home_win, 1.0)))
        away_score = int(max(0, rng.normal(1.9 + 0.4 * (1.0 - p_home_win), 1.0)))

        if home_win and home_score <= away_score:
            home_score = away_score + 1
        if (not home_win) and away_score <= home_score:
            away_score = home_score + 1

        p_home_no_vig = np.clip(p_home_win, 0.05, 0.95)
        p_away_no_vig = 1.0 - p_home_no_vig
        vig = 1.04
        home_odds = vig / p_home_no_vig
        away_odds = vig / p_away_no_vig

        records.append(
            {
                "date": dates[i].isoformat(),
                "league": league,
                "home_team": home,
                "away_team": away,
                "home_score": home_score,
                "away_score": away_score,
                "home_odds": round(float(home_odds), 3),
                "away_odds": round(float(away_odds), 3),
                "home_rest_days": max(0.0, round(3.0 + rest_diff / 2.0, 2)),
                "away_rest_days": max(0.0, round(3.0 - rest_diff / 2.0, 2)),
                "travel_km_diff": round(float(travel_km_diff), 2),
                "is_b2b_home": int(rng.random() < 0.15),
                "is_b2b_away": int(rng.random() < 0.15),
                "injury_impact_home": round(float(max(0.0, rng.normal(1.2, 0.8))), 2),
                "injury_impact_away": round(float(max(0.0, rng.normal(1.2 + injury_diff, 0.8))), 2),
                "sentiment_home": round(float(np.clip(rng.normal(0.0 + sentiment_diff, 0.5), -1.0, 1.0)), 3),
                "sentiment_away": round(float(np.clip(rng.normal(0.0 - sentiment_diff, 0.5), -1.0, 1.0)), 3),
                "weather_temp_c": round(weather_temp_c, 2),
                "weather_wind_kph": round(weather_wind_kph, 2),
                "closing_home_odds": round(float(home_odds * rng.normal(0.995, 0.01)), 3),
                "closing_away_odds": round(float(away_odds * rng.normal(0.995, 0.01)), 3),
            }
        )

    return pd.DataFrame(records)


def write_sample_data(out_path: str, rows: int, seed: int) -> str:
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    df = generate_sample_data(rows=rows, seed=seed)
    df.to_csv(out_path, index=False)
    return out_path
