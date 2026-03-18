from __future__ import annotations

import pandas as pd
import numpy as np

from sports_model.mlb_historical_ingest import add_rolling_pitcher_era


REQUIRED_COLUMNS = [
    "date",
    "league",
    "home_team",
    "away_team",
    "home_score",
    "away_score",
    "home_odds",
    "away_odds",
]


OPTIONAL_DEFAULTS = {
    "home_rest_days": 3.0,
    "away_rest_days": 3.0,
    "travel_km_diff": 0.0,
    "is_b2b_home": 0,
    "is_b2b_away": 0,
    "injury_impact_home": 0.0,
    "injury_impact_away": 0.0,
    "sentiment_home": 0.0,
    "sentiment_away": 0.0,
    "weather_temp_c": 18.0,
    "weather_wind_kph": 10.0,
    "closing_home_odds": None,
    "closing_away_odds": None,
    # Sport-specific (soccer)
    "home_possession": None,
    "away_possession": None,
    "home_shots": None,
    "away_shots": None,
    "home_shots_on_target": None,
    "away_shots_on_target": None,
    "home_corners": None,
    "away_corners": None,
    # Sport-specific (NBA)
    "home_rebounds": None,
    "away_rebounds": None,
    "home_turnovers": None,
    "away_turnovers": None,
    # Sport-specific (MLB)
    "home_hits": None,
    "away_hits": None,
    "home_errors": None,
    "away_errors": None,
    # Standings features (from ESPN Standings API)
    "home_standing_rank": None,
    "away_standing_rank": None,
    "home_standing_win_pct": None,
    "away_standing_win_pct": None,
    "home_standing_gd": None,
    "away_standing_gd": None,
    "home_standing_points": None,
    "away_standing_points": None,
    # Form string (from ESPN)
    "home_form_str": None,
    "away_form_str": None,
}


def _validate(df: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns: {missing}")


def _prepare_base(df: pd.DataFrame) -> pd.DataFrame:
    _validate(df)
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"], utc=True, format="mixed")

    for col, default in OPTIONAL_DEFAULTS.items():
        if col not in out.columns:
            out[col] = default

    out = out.sort_values("date").reset_index(drop=True)
    out["closing_home_odds"] = out["closing_home_odds"].fillna(out["home_odds"])
    out["closing_away_odds"] = out["closing_away_odds"].fillna(out["away_odds"])
    out["home_win"] = (out["home_score"] > out["away_score"]).astype(int)
    out["total_points"] = out["home_score"] + out["away_score"]
    return out


# ---------------------------------------------------------------------------
# Real rest-days computation (point-in-time, no lookahead)
# ---------------------------------------------------------------------------

def _compute_rest_days(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute actual days since each team's previous game, using only the
    date column and team names from our historical data.

    This replaces the all-null home_rest_days / away_rest_days columns.
    A game's rest value is the gap BEFORE that game (safe, no lookahead).
    Default = 7 days for a team's first appearance.
    """
    df = df.copy()
    df = df.sort_values("date").reset_index(drop=True)

    # Build a per-team last-game-date lookup by iterating chronologically
    last_date: dict[str, pd.Timestamp] = {}
    home_rest = []
    away_rest = []

    for _, row in df.iterrows():
        h, a = row["home_team"], row["away_team"]
        d = row["date"]

        h_rest = (d - last_date[h]).days if h in last_date else 7
        a_rest = (d - last_date[a]).days if a in last_date else 7

        home_rest.append(float(h_rest))
        away_rest.append(float(a_rest))

        # Update last date AFTER recording rest (point-in-time)
        last_date[h] = d
        last_date[a] = d

    df["home_rest_days"] = home_rest
    df["away_rest_days"] = away_rest

    # Back-fill is_b2b from real rest days
    df["is_b2b_home"] = (df["home_rest_days"] <= 1).astype(float)
    df["is_b2b_away"] = (df["away_rest_days"] <= 1).astype(float)

    return df


# ---------------------------------------------------------------------------
# Rolling helpers — multiple windows
# ---------------------------------------------------------------------------

def _rolling_team(df: pd.DataFrame, group_col: str, value_col: str, window: int = 5):  # type: ignore[return]
    """Point-in-time rolling mean per team (shifted by 1 to avoid lookahead)."""
    return df.groupby(group_col)[value_col].transform(
        lambda s: s.shift(1).rolling(window, min_periods=1).mean()
    )


def _add_multi_window_rolling(
    games: pd.DataFrame,
    home_col: str,
    away_col: str,
    home_team_col: str = "home_team",
    away_team_col: str = "away_team",
    windows: tuple[int, ...] = (5, 10, 20),
    feat_prefix: str = "",
) -> pd.DataFrame:
    """
    Add rolling means at multiple window sizes for a scored/allowed pair.
    Returns games with new columns:
        {prefix}home_{w}, {prefix}away_{w}  for each window w
    """
    for w in windows:
        games[f"{feat_prefix}home_{w}"] = _rolling_team(games, home_team_col, home_col, w)
        games[f"{feat_prefix}away_{w}"] = _rolling_team(games, away_team_col, away_col, w)
    return games


# ---------------------------------------------------------------------------
# Form string → numeric momentum
# ---------------------------------------------------------------------------

def _form_to_score(form_str: str | None) -> float:
    """
    Convert a form string like 'WWLDD' to a weighted momentum score.
    Most recent result weighted highest (last char = most recent).
    W=1, D=0.5, L=0  — weighted average with recency weights.
    Returns 0.5 if no form data.
    """
    if not form_str or not isinstance(form_str, str):
        return 0.5
    mapping = {"W": 1.0, "D": 0.5, "L": 0.0}
    chars = [c for c in form_str.upper() if c in mapping]
    if not chars:
        return 0.5
    n = len(chars)
    # Recency weights: most recent (last) gets highest weight
    weights = [float(i + 1) for i in range(n)]
    total_w = sum(weights)
    score = sum(mapping[c] * w for c, w in zip(chars, weights)) / total_w
    return score


# ---------------------------------------------------------------------------
# Sport-specific feature blocks
# ---------------------------------------------------------------------------

def _add_soccer_features(games: pd.DataFrame) -> pd.DataFrame:
    """xG proxy and dominance metrics from shots / possession."""
    if "home_shots" in games.columns and "home_shots_on_target" in games.columns:
        games["home_shot_acc"] = (
            games["home_shots_on_target"] / games["home_shots"].replace(0, pd.NA)
        ).fillna(0.0)
        games["away_shot_acc"] = (
            games["away_shots_on_target"] / games["away_shots"].replace(0, pd.NA)
        ).fillna(0.0)
        games["home_shot_acc_5"]  = _rolling_team(games, "home_team", "home_shot_acc", 5)
        games["away_shot_acc_5"]  = _rolling_team(games, "away_team", "away_shot_acc", 5)
        games["home_shot_acc_10"] = _rolling_team(games, "home_team", "home_shot_acc", 10)
        games["away_shot_acc_10"] = _rolling_team(games, "away_team", "away_shot_acc", 10)
        games["shot_acc_diff"]    = games["home_shot_acc_5"] - games["away_shot_acc_5"]
        games["shot_acc_diff_10"] = games["home_shot_acc_10"] - games["away_shot_acc_10"]
    else:
        games["shot_acc_diff"]    = 0.0
        games["shot_acc_diff_10"] = 0.0

    if "home_shots_on_target" in games.columns:
        games["home_sot_5"] = _rolling_team(games, "home_team", "home_shots_on_target", 5)
        games["away_sot_5"] = _rolling_team(games, "away_team", "away_shots_on_target", 5)
        games["sot_diff"]   = games["home_sot_5"] - games["away_sot_5"]
    else:
        games["sot_diff"] = 0.0

    if "home_possession" in games.columns:
        games["home_poss_5"] = _rolling_team(games, "home_team", "home_possession", 5)
        games["away_poss_5"] = _rolling_team(games, "away_team", "away_possession", 5)
        games["possession_diff"] = games["home_poss_5"] - games["away_poss_5"]
    else:
        games["possession_diff"] = 0.0

    if "home_corners" in games.columns:
        games["home_corners_5"] = _rolling_team(games, "home_team", "home_corners", 5)
        games["away_corners_5"] = _rolling_team(games, "away_team", "away_corners", 5)
        games["corners_diff"]   = games["home_corners_5"] - games["away_corners_5"]
    else:
        games["corners_diff"] = 0.0

    return games


def _add_nba_features(games: pd.DataFrame) -> pd.DataFrame:
    """Pace and efficiency proxies for NBA."""
    if "home_rebounds" in games.columns:
        games["home_reb_5"] = _rolling_team(games, "home_team", "home_rebounds", 5)
        games["away_reb_5"] = _rolling_team(games, "away_team", "away_rebounds", 5)
        games["rebound_diff"] = games["home_reb_5"] - games["away_reb_5"]
    else:
        games["rebound_diff"] = 0.0

    if "home_turnovers" in games.columns:
        games["home_to_5"] = _rolling_team(games, "home_team", "home_turnovers", 5)
        games["away_to_5"] = _rolling_team(games, "away_team", "away_turnovers", 5)
        games["turnover_diff"] = games["away_to_5"] - games["home_to_5"]
    else:
        games["turnover_diff"] = 0.0

    return games


def _add_mlb_features(games: pd.DataFrame) -> pd.DataFrame:
    """Run support and fielding proxies for MLB."""
    if "home_hits" in games.columns:
        games["home_hits_5"]  = _rolling_team(games, "home_team", "home_hits", 5)
        games["away_hits_5"]  = _rolling_team(games, "away_team", "away_hits", 5)
        games["home_hits_10"] = _rolling_team(games, "home_team", "home_hits", 10)
        games["away_hits_10"] = _rolling_team(games, "away_team", "away_hits", 10)
        games["hits_diff"]    = games["home_hits_5"] - games["away_hits_5"]
        games["hits_diff_10"] = games["home_hits_10"] - games["away_hits_10"]
    else:
        games["hits_diff"]    = 0.0
        games["hits_diff_10"] = 0.0

    if "home_errors" in games.columns:
        games["home_err_5"] = _rolling_team(games, "home_team", "home_errors", 5)
        games["away_err_5"] = _rolling_team(games, "away_team", "away_errors", 5)
        games["errors_diff"] = games["away_err_5"] - games["home_err_5"]
    else:
        games["errors_diff"] = 0.0

    # --- Starting pitcher ERA proxy (point-in-time rolling from game results) ---
    if "home_sp" in games.columns:
        games = add_rolling_pitcher_era(games)
    else:
        games["home_sp_era_proxy"] = 4.50
        games["away_sp_era_proxy"] = 4.50
        games["sp_era_diff"]       = 0.0
        games["sp_winrate_diff"]   = 0.0

    return games


# ---------------------------------------------------------------------------
# H2H, venue-split, and streak features
# ---------------------------------------------------------------------------

def _add_h2h_features(games: pd.DataFrame) -> pd.DataFrame:
    """
    Head-to-head win rate for home team in last 5 meetings between these
    two teams (regardless of who was home/away), point-in-time.
    """
    games = games.copy()
    games["h2h_home_win_rate"] = 0.5  # default

    # Build a sorted team-pair key for fast lookup
    games["_pair"] = games.apply(
        lambda r: tuple(sorted([r["home_team"], r["away_team"]])), axis=1
    )

    pair_history: dict[tuple, list[int]] = {}  # pair → list of (1=home_team_won, 0=away_team_won)

    results = []
    for _, row in games.iterrows():
        pair = row["_pair"]
        home = row["home_team"]
        past = pair_history.get(pair, [])
        if len(past) >= 1:
            rate = sum(1 for p, h in past[-5:] if h == home) / len(past[-5:])
        else:
            rate = 0.5
        results.append(rate)
        # Record this result AFTER computing (point-in-time)
        winner = home if row["home_win"] == 1 else row["away_team"]
        pair_history.setdefault(pair, []).append((1, winner))

    games["h2h_home_win_rate"] = results
    games = games.drop(columns=["_pair"])
    return games


def _add_venue_split_features(games: pd.DataFrame) -> pd.DataFrame:
    """
    Rolling home win rate for home team (last 10 home games) and
    away win rate for away team (last 10 away games). Point-in-time.
    """
    games = games.copy()

    # Home win indicator for each row from home team's perspective
    games["_home_win_flag"] = games["home_win"].astype(float)
    # Away team wins when home_win == 0
    games["_away_win_flag"] = (1 - games["home_win"]).astype(float)

    games["home_venue_win_rate"] = (
        games.groupby("home_team")["_home_win_flag"]
        .transform(lambda s: s.shift(1).rolling(10, min_periods=1).mean())
        .fillna(0.5)
    )
    games["away_venue_win_rate"] = (
        games.groupby("away_team")["_away_win_flag"]
        .transform(lambda s: s.shift(1).rolling(10, min_periods=1).mean())
        .fillna(0.5)
    )
    games["venue_win_rate_diff"] = games["home_venue_win_rate"] - games["away_venue_win_rate"]

    games = games.drop(columns=["_home_win_flag", "_away_win_flag"])
    return games


def _add_streak_features(games: pd.DataFrame) -> pd.DataFrame:
    """
    Current win/loss streak for each team going into this game.
    Positive = win streak, negative = loss streak. Capped at ±10.
    Point-in-time (uses results up to but not including current game).
    """
    games = games.copy()
    team_streak: dict[str, int] = {}

    home_streaks, away_streaks = [], []
    for _, row in games.iterrows():
        h, a = row["home_team"], row["away_team"]
        home_streaks.append(float(np.clip(team_streak.get(h, 0), -10, 10)))
        away_streaks.append(float(np.clip(team_streak.get(a, 0), -10, 10)))

        # Update streaks AFTER recording (point-in-time)
        if row["home_win"] == 1:
            team_streak[h] = max(1, team_streak.get(h, 0) + 1)
            team_streak[a] = min(-1, team_streak.get(a, 0) - 1)
        else:
            team_streak[h] = min(-1, team_streak.get(h, 0) - 1)
            team_streak[a] = max(1, team_streak.get(a, 0) + 1)

    games["home_streak"] = home_streaks
    games["away_streak"] = away_streaks
    games["streak_diff"] = games["home_streak"] - games["away_streak"]
    return games


# ---------------------------------------------------------------------------
# Main feature builder
# ---------------------------------------------------------------------------

def build_features(df: pd.DataFrame):
    games = _prepare_base(df)

    # --- Compute real rest days from game history (replaces all-null columns) ---
    games = _compute_rest_days(games)

    # --- Core rolling scoring: 5, 10, 20 game windows ---
    for w in (5, 10, 20):
        games[f"home_scored_{w}"]  = _rolling_team(games, "home_team", "home_score", w)
        games[f"away_scored_{w}"]  = _rolling_team(games, "away_team", "away_score", w)
        games[f"home_allowed_{w}"] = _rolling_team(games, "home_team", "away_score", w)
        games[f"away_allowed_{w}"] = _rolling_team(games, "away_team", "home_score", w)

    # Pace proxy (global, multi-window)
    games["pace_proxy_5"]  = games["total_points"].shift(1).rolling(5,  min_periods=1).mean()
    games["pace_proxy_10"] = games["total_points"].shift(1).rolling(10, min_periods=1).mean()

    # --- Efficiency differentials at each window ---
    for w in (5, 10, 20):
        games[f"off_eff_diff_{w}"] = games[f"home_scored_{w}"]  - games[f"away_scored_{w}"]
        games[f"def_eff_diff_{w}"] = games[f"away_allowed_{w}"] - games[f"home_allowed_{w}"]

    # Keep unprefixed aliases for w=5 (backwards compat with live inference)
    games["home_scored_5"]  = games["home_scored_5"]
    games["away_scored_5"]  = games["away_scored_5"]
    games["home_allowed_5"] = games["home_allowed_5"]
    games["away_allowed_5"] = games["away_allowed_5"]
    games["pace_proxy_5"]   = games["pace_proxy_5"]
    games["off_eff_diff"]   = games["off_eff_diff_5"]
    games["def_eff_diff"]   = games["def_eff_diff_5"]

    # --- Rest features (now real, not zero) ---
    games["rest_diff"]   = games["home_rest_days"] - games["away_rest_days"]
    games["rest_home"]   = games["home_rest_days"]   # raw rest for home team
    games["rest_away"]   = games["away_rest_days"]   # raw rest for away team
    # Non-linear: very short rest (<3 days) is a fatigue signal
    games["home_fatigue"] = (games["home_rest_days"] < 3).astype(float)
    games["away_fatigue"] = (games["away_rest_days"] < 3).astype(float)
    games["fatigue_diff"] = games["away_fatigue"] - games["home_fatigue"]  # positive = away more fatigued

    games["injury_diff"]   = games["injury_impact_away"] - games["injury_impact_home"]
    games["sentiment_diff"] = games["sentiment_home"] - games["sentiment_away"]
    games["b2b_diff"]      = games["is_b2b_away"] - games["is_b2b_home"]

    # --- Home/away split form rate ---
    # home_form_rate exists for ~2,184 soccer rows; convert to rolling
    if "home_form_rate" in games.columns and games["home_form_rate"].notna().any():
        games["home_form_rate_roll5"]  = _rolling_team(games, "home_team", "home_form_rate", 5)
        games["away_form_rate_roll5"]  = _rolling_team(games, "away_team", "away_form_rate", 5)
        games["form_rate_diff"]        = (
            games["home_form_rate_roll5"].fillna(0.5) - games["away_form_rate_roll5"].fillna(0.5)
        )
    else:
        games["form_rate_diff"] = 0.0

    # --- Form string momentum score ---
    if "home_form_str" in games.columns:
        games["home_form_momentum"] = games["home_form_str"].apply(_form_to_score)
        games["away_form_momentum"] = games["away_form_str"].apply(_form_to_score)
        games["form_momentum_diff"] = games["home_form_momentum"] - games["away_form_momentum"]
    else:
        games["form_momentum_diff"] = 0.0

    # --- Standings features ---
    if "home_standing_rank" in games.columns and "away_standing_rank" in games.columns:
        games["standing_rank_diff"]    = games["away_standing_rank"].fillna(20)  - games["home_standing_rank"].fillna(20)
        games["standing_win_pct_diff"] = games["home_standing_win_pct"].fillna(0.5) - games["away_standing_win_pct"].fillna(0.5)
        games["standing_gd_diff"]      = games["home_standing_gd"].fillna(0)     - games["away_standing_gd"].fillna(0)
        games["standing_pts_diff"]     = games["home_standing_points"].fillna(0) - games["away_standing_points"].fillna(0)
    else:
        games["standing_rank_diff"]    = 0.0
        games["standing_win_pct_diff"] = 0.0
        games["standing_gd_diff"]      = 0.0
        games["standing_pts_diff"]     = 0.0

    # --- H2H win rate (last 5 meetings between same two teams, point-in-time) ---
    games = _add_h2h_features(games)

    # --- Home/away split win rates ---
    games = _add_venue_split_features(games)

    # --- Win streak (consecutive wins/losses, capped at ±10) ---
    games = _add_streak_features(games)

    # --- Last-3 form (very short-term momentum) ---
    for w in (3,):
        games[f"home_scored_{w}"]  = _rolling_team(games, "home_team", "home_score", w)
        games[f"away_scored_{w}"]  = _rolling_team(games, "away_team", "away_score", w)
        games[f"home_allowed_{w}"] = _rolling_team(games, "home_team", "away_score", w)
        games[f"away_allowed_{w}"] = _rolling_team(games, "away_team", "home_score", w)
        games[f"off_eff_diff_{w}"] = games[f"home_scored_{w}"] - games[f"away_scored_{w}"]
        games[f"def_eff_diff_{w}"] = games[f"away_allowed_{w}"] - games[f"home_allowed_{w}"]

    # --- Sport-specific features ---
    games = _add_soccer_features(games)
    games = _add_nba_features(games)
    games = _add_mlb_features(games)

    feature_cols = [
        # Core — 5-game window (kept for backwards compat)
        "home_scored_5",
        "away_scored_5",
        "home_allowed_5",
        "away_allowed_5",
        "pace_proxy_5",
        "off_eff_diff",
        "def_eff_diff",
        # 10-game window (medium-term form)
        "home_scored_10",
        "away_scored_10",
        "home_allowed_10",
        "away_allowed_10",
        "pace_proxy_10",
        "off_eff_diff_10",
        "def_eff_diff_10",
        # 20-game window (season-level baseline)
        "home_scored_20",
        "away_scored_20",
        "home_allowed_20",
        "away_allowed_20",
        "off_eff_diff_20",
        "def_eff_diff_20",
        # Real rest features
        "rest_diff",
        "rest_home",
        "rest_away",
        "home_fatigue",
        "away_fatigue",
        "fatigue_diff",
        "b2b_diff",
        # Form
        "form_rate_diff",
        "form_momentum_diff",
        # Context
        "travel_km_diff",
        "injury_diff",
        "sentiment_diff",
        "weather_temp_c",
        "weather_wind_kph",
        # Standings
        "standing_rank_diff",
        "standing_win_pct_diff",
        "standing_gd_diff",
        "standing_pts_diff",
        # Soccer
        "shot_acc_diff",
        "shot_acc_diff_10",
        "sot_diff",
        "possession_diff",
        "corners_diff",
        # NBA
        "rebound_diff",
        "turnover_diff",
        # MLB
        "hits_diff",
        "hits_diff_10",
        "errors_diff",
        "home_sp_era_proxy",
        "away_sp_era_proxy",
        "sp_era_diff",
        "sp_winrate_diff",
        # H2H
        "h2h_home_win_rate",
        # Venue split
        "home_venue_win_rate",
        "away_venue_win_rate",
        "venue_win_rate_diff",
        # Streak
        "home_streak",
        "away_streak",
        "streak_diff",
        # Last-3 short-term form
        "off_eff_diff_3",
        "def_eff_diff_3",
    ]

    X = games[feature_cols].fillna(0.0).copy()
    y = games["home_win"].copy().astype(int)
    meta_cols = [
        "date",
        "league",
        "home_team",
        "away_team",
        "home_score",
        "away_score",
        "home_odds",
        "away_odds",
        "closing_home_odds",
        "closing_away_odds",
    ]
    meta = games[meta_cols].copy()

    return X, y, meta
