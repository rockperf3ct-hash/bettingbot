"""
AI-powered bet recommendations.

Flow:
1. Fetch today's upcoming/live games from ESPN scoreboard.
2. Build a minimal feature row for each game using:
   - Rolling averages from historical_games.csv (last N completed games per team)
   - Live ESPN standings (rank, win%, GD, pts)
   - Default values for anything unavailable
3. Score each game with the trained sport-specific model (soccer/nba/mlb).
4. Filter to games with positive edge (implied prob vs market odds).
5. Classify confidence tier: Strong (edge>8%), Moderate (5-8%), Lean (3-5%).
6. Send the top picks to Gemini 2.5 Flash for:
   - Human-readable rationale per pick
   - A suggested 2-3 leg parlay
7. Return structured JSON the API can serve directly.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

ARTIFACTS_DIR = Path(os.getenv("ARTIFACTS_DIR", "artifacts"))
DATA_DIR = Path(os.getenv("DATA_DIR", "data"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = "models/gemini-3.1-pro-preview"  # Most current Gemini model as of this project

# How many past games to use for rolling team stats
ROLLING_WINDOW = 5
MIN_EDGE = 0.03   # 3% minimum edge to consider a pick


# ---------------------------------------------------------------------------
# Feature helpers
# ---------------------------------------------------------------------------

def _rolling_team_stats(hist: pd.DataFrame, team: str, side: str, n: int = ROLLING_WINDOW) -> dict:
    """
    Return rolling average stats for a team from historical data.
    side: 'home' or 'away'
    """
    mask = hist[f"{side}_team"] == team
    recent = hist[mask].sort_values("date").tail(n)
    if recent.empty:
        return {}
    out: dict[str, float] = {}
    for col in ["home_score", "away_score"]:
        if col in recent.columns:
            out[col] = recent[col].mean()
    return out


def _build_feature_row(
    game: dict,
    hist: pd.DataFrame,
    standings_lookup: dict[str, dict],
    sport: str,
    team_index: dict | None = None,
) -> dict:
    """
    Build a single feature dict for an upcoming game.
    Uses the same feature names as the trained model — multi-window rolling stats
    at windows 5, 10, and 20, plus rest days, form momentum, pitcher ERA proxy.

    team_index: optional pre-built {team: sorted_df} for O(1) lookups (much faster).
    If not provided, falls back to scanning hist directly (slower).
    """
    home = game.get("home_team", "")
    away = game.get("away_team", "")

    def _team_games(team: str) -> pd.DataFrame:
        """Get all games for a team, sorted by date — uses index if available."""
        if team_index is not None:
            return team_index.get(team, pd.DataFrame())
        mask = (hist["home_team"] == team) | (hist["away_team"] == team)
        return hist[mask].sort_values("date")

    # --- Rolling scoring stats at multiple windows ---
    def team_scored(team: str, n: int) -> float:
        tg = _team_games(team)
        if tg.empty:
            return 1.2
        hm = tg[tg["home_team"] == team].tail(n)["home_score"]
        aw = tg[tg["away_team"] == team].tail(n)["away_score"]
        combined = pd.concat([hm, aw]).dropna()
        return float(combined.mean()) if not combined.empty else 1.2

    def team_allowed(team: str, n: int) -> float:
        tg = _team_games(team)
        if tg.empty:
            return 1.2
        hm = tg[tg["home_team"] == team].tail(n)["away_score"]
        aw = tg[tg["away_team"] == team].tail(n)["home_score"]
        combined = pd.concat([hm, aw]).dropna()
        return float(combined.mean()) if not combined.empty else 1.2

    # Compute at all three windows
    h5  = team_scored(home, 5);   a5  = team_scored(away, 5)
    h10 = team_scored(home, 10);  a10 = team_scored(away, 10)
    h20 = team_scored(home, 20);  a20 = team_scored(away, 20)
    hd5  = team_allowed(home, 5);   ad5  = team_allowed(away, 5)
    hd10 = team_allowed(home, 10);  ad10 = team_allowed(away, 10)
    hd20 = team_allowed(home, 20);  ad20 = team_allowed(away, 20)

    # Pace proxy (simple average of recent totals)
    pace5  = (h5  + a5)  / 2
    pace10 = (h10 + a10) / 2

    # --- Rest days: last game date per team ---
    def last_game_date(team: str):
        tg = _team_games(team)
        if tg.empty:
            return None
        return pd.to_datetime(tg["date"].iloc[-1], utc=True)

    today_ts = pd.Timestamp.now(tz="UTC")
    h_last = last_game_date(home)
    a_last = last_game_date(away)
    h_rest = float((today_ts - h_last).days) if h_last is not None else 7.0
    a_rest = float((today_ts - a_last).days) if a_last is not None else 7.0
    h_fatigue = 1.0 if h_rest < 3 else 0.0
    a_fatigue = 1.0 if a_rest < 3 else 0.0

    # --- Standings ---
    hs  = standings_lookup.get(home, {})
    as_ = standings_lookup.get(away, {})

    h_rank = float(hs.get("standing_rank") or 10)
    a_rank = float(as_.get("standing_rank") or 10)
    h_wpct = float(hs.get("standing_win_pct") or 0.5)
    a_wpct = float(as_.get("standing_win_pct") or 0.5)
    h_gd   = float(hs.get("standing_gd") or 0)
    a_gd   = float(as_.get("standing_gd") or 0)
    h_pts  = float(hs.get("standing_points") or 0)
    a_pts  = float(as_.get("standing_points") or 0)

    # --- MLB pitcher ERA proxy ---
    # Look up the team's recent starts and compute a simple rolling ERA proxy
    def pitcher_era_proxy(team: str, is_home: bool, n: int = 10) -> float:
        """Approximate ERA from runs allowed in last N home/away starts."""
        tg = _team_games(team)
        if tg.empty:
            return 4.50
        if is_home:
            starts = tg[tg["home_team"] == team].tail(n)
            runs_allowed = starts["away_score"].dropna()
        else:
            starts = tg[tg["away_team"] == team].tail(n)
            runs_allowed = starts["home_score"].dropna()
        if runs_allowed.empty:
            return 4.50
        return float(runs_allowed.mean() * 9.0 / 6.0)

    h_sp_era = pitcher_era_proxy(home, is_home=True)
    a_sp_era = pitcher_era_proxy(away, is_home=False)

    # --- H2H win rate (last 10 meetings, home team perspective) ---
    def _h2h_win_rate(home_team: str, away_team: str, n: int = 10) -> float:
        h_games = _team_games(home_team)
        a_games = _team_games(away_team)
        if h_games.empty or a_games.empty:
            return 0.5
        # Find games where these two teams met (either way)
        h2h = hist[
            ((hist["home_team"] == home_team) & (hist["away_team"] == away_team)) |
            ((hist["home_team"] == away_team) & (hist["away_team"] == home_team))
        ].tail(n)
        if h2h.empty:
            return 0.5
        wins = ((h2h["home_team"] == home_team) & (h2h["home_score"] > h2h["away_score"])) | \
               ((h2h["away_team"] == home_team) & (h2h["away_score"] > h2h["home_score"]))
        return float(wins.sum() / len(h2h))

    # --- Venue split win rate ---
    def _venue_win_rate(team: str, is_home: bool, n: int = 10) -> float:
        tg = _team_games(team)
        if tg.empty:
            return 0.5
        if is_home:
            venue_games = tg[tg["home_team"] == team].tail(n)
            wins = (venue_games["home_score"] > venue_games["away_score"]).sum()
        else:
            venue_games = tg[tg["away_team"] == team].tail(n)
            wins = (venue_games["away_score"] > venue_games["home_score"]).sum()
        total = len(venue_games)
        return float(wins / total) if total > 0 else 0.5

    # --- Current win/loss streak ---
    def _current_streak(team: str, n: int = 10) -> float:
        tg = _team_games(team).tail(n)
        if tg.empty:
            return 0.0
        streak = 0
        for _, row_g in tg.iloc[::-1].iterrows():
            if row_g["home_team"] == team:
                won = row_g["home_score"] > row_g["away_score"]
            else:
                won = row_g["away_score"] > row_g["home_score"]
            if streak == 0:
                streak = 1 if won else -1
            elif (streak > 0 and won) or (streak < 0 and not won):
                streak += 1 if won else -1
            else:
                break
        return float(max(-10, min(10, streak)))

    row: dict[str, Any] = {
        # 5-game window
        "home_scored_5":   h5,
        "away_scored_5":   a5,
        "home_allowed_5":  hd5,
        "away_allowed_5":  ad5,
        "pace_proxy_5":    pace5,
        "off_eff_diff":    h5  - a5,
        "def_eff_diff":    ad5 - hd5,
        # 10-game window
        "home_scored_10":  h10,
        "away_scored_10":  a10,
        "home_allowed_10": hd10,
        "away_allowed_10": ad10,
        "pace_proxy_10":   pace10,
        "off_eff_diff_10": h10  - a10,
        "def_eff_diff_10": ad10 - hd10,
        # 20-game window
        "home_scored_20":  h20,
        "away_scored_20":  a20,
        "home_allowed_20": hd20,
        "away_allowed_20": ad20,
        "off_eff_diff_20": h20  - a20,
        "def_eff_diff_20": ad20 - hd20,
        # Rest / fatigue
        "rest_diff":       h_rest - a_rest,
        "rest_home":       h_rest,
        "rest_away":       a_rest,
        "home_fatigue":    h_fatigue,
        "away_fatigue":    a_fatigue,
        "fatigue_diff":    a_fatigue - h_fatigue,
        "b2b_diff":        0.0,
        # Form momentum (no live form string — use 0)
        "form_rate_diff":    0.0,
        "form_momentum_diff": 0.0,
        # Context
        "injury_diff":     0.0,
        "sentiment_diff":  0.0,
        "weather_temp_c":  18.0,
        "weather_wind_kph": 10.0,
        # Standings
        "standing_rank_diff":    a_rank - h_rank,
        "standing_win_pct_diff": h_wpct - a_wpct,
        "standing_gd_diff":      h_gd   - a_gd,
        "standing_pts_diff":     h_pts  - a_pts,
        # Soccer-specific
        "shot_acc_diff":    0.0,
        "shot_acc_diff_10": 0.0,
        "sot_diff":         0.0,
        "possession_diff":  0.0,
        "corners_diff":     0.0,
        # NBA-specific
        "rebound_diff":  0.0,
        "turnover_diff": 0.0,
        # MLB-specific
        "home_sp_era_proxy":   h_sp_era,
        "away_sp_era_proxy":   a_sp_era,
        "sp_era_diff":         a_sp_era - h_sp_era,
        "sp_winrate_diff":     0.0,
        # --- New features (added in model improvement pass) ---
        # H2H: approximate from last 10 meetings in historical data
        "h2h_home_win_rate":   _h2h_win_rate(home, away),
        # Venue split: home/away win rates
        "home_venue_win_rate": _venue_win_rate(home, is_home=True),
        "away_venue_win_rate": _venue_win_rate(away, is_home=False),
        "venue_win_rate_diff": _venue_win_rate(home, is_home=True) - _venue_win_rate(away, is_home=False),
        # Streak
        "home_streak":  _current_streak(home),
        "away_streak":  _current_streak(away),
        "streak_diff":  _current_streak(home) - _current_streak(away),
        # Last-3 form
        "off_eff_diff_3": team_scored(home, 3) - team_scored(away, 3),
        "def_eff_diff_3": team_allowed(away, 3) - team_allowed(home, 3),
    }
    return row


def _load_model(sport: str):
    """Load sport-specific model, fall back to mixed model."""
    path = ARTIFACTS_DIR / f"{sport}_model.joblib"
    if path.exists():
        return joblib.load(path)
    fallback = ARTIFACTS_DIR / "model.joblib"
    if fallback.exists():
        return joblib.load(fallback)
    return None


def _get_sport(game: dict) -> str:
    league = (game.get("league") or game.get("sport") or "").lower()
    if any(x in league for x in ["nba", "basketball"]):
        return "nba"
    if any(x in league for x in ["mlb", "baseball"]):
        return "mlb"
    return "soccer"


def _sport_features(sport: str) -> list[str]:
    """Return features in exact order the model was trained with (mirrors sport_models.py)."""
    if sport == "soccer":
        return [
            # 5-game form
            "home_scored_5", "away_scored_5", "home_allowed_5", "away_allowed_5",
            "pace_proxy_5", "off_eff_diff", "def_eff_diff",
            # 10-game form
            "home_scored_10", "away_scored_10", "home_allowed_10", "away_allowed_10",
            "pace_proxy_10", "off_eff_diff_10", "def_eff_diff_10",
            # 20-game baseline
            "home_scored_20", "away_scored_20", "home_allowed_20", "away_allowed_20",
            "off_eff_diff_20", "def_eff_diff_20",
            # Rest
            "rest_diff", "rest_home", "rest_away", "home_fatigue", "away_fatigue", "fatigue_diff",
            "b2b_diff",
            # Form momentum
            "form_rate_diff", "form_momentum_diff",
            # Context
            "injury_diff", "sentiment_diff", "weather_temp_c", "weather_wind_kph",
            # Standings
            "standing_rank_diff", "standing_win_pct_diff", "standing_gd_diff", "standing_pts_diff",
            # Soccer-specific
            "shot_acc_diff", "shot_acc_diff_10", "sot_diff", "possession_diff", "corners_diff",
            # New features
            "h2h_home_win_rate", "venue_win_rate_diff", "streak_diff", "off_eff_diff_3", "def_eff_diff_3",
        ]
    if sport == "nba":
        return [
            # 5-game form
            "home_scored_5", "away_scored_5", "home_allowed_5", "away_allowed_5",
            "pace_proxy_5", "off_eff_diff", "def_eff_diff",
            # 10-game form
            "home_scored_10", "away_scored_10", "home_allowed_10", "away_allowed_10",
            "pace_proxy_10", "off_eff_diff_10", "def_eff_diff_10",
            # 20-game baseline
            "home_scored_20", "away_scored_20", "home_allowed_20", "away_allowed_20",
            "off_eff_diff_20", "def_eff_diff_20",
            # Rest
            "rest_diff", "rest_home", "rest_away", "home_fatigue", "away_fatigue", "fatigue_diff",
            "b2b_diff",
            # Form momentum
            "form_momentum_diff",
            # Context
            "injury_diff", "sentiment_diff",
            # Standings
            "standing_rank_diff", "standing_win_pct_diff", "standing_gd_diff",
            # NBA-specific
            "rebound_diff", "turnover_diff",
            # New features
            "h2h_home_win_rate", "venue_win_rate_diff", "home_streak", "away_streak", "streak_diff",
            "off_eff_diff_3", "def_eff_diff_3",
        ]
    if sport == "mlb":
        return [
            # 5-game form
            "home_scored_5", "away_scored_5", "home_allowed_5", "away_allowed_5",
            "pace_proxy_5", "off_eff_diff", "def_eff_diff",
            # 10-game form
            "home_scored_10", "away_scored_10", "home_allowed_10", "away_allowed_10",
            "pace_proxy_10", "off_eff_diff_10", "def_eff_diff_10",
            # 20-game baseline
            "home_scored_20", "away_scored_20", "home_allowed_20", "away_allowed_20",
            "off_eff_diff_20", "def_eff_diff_20",
            # Rest
            "rest_diff", "rest_home", "rest_away", "fatigue_diff", "b2b_diff",
            # Context
            "injury_diff", "sentiment_diff", "weather_temp_c", "weather_wind_kph",
            # Standings
            "standing_rank_diff", "standing_win_pct_diff",
            # MLB-specific
            "hits_diff", "hits_diff_10", "errors_diff",
            # Pitcher ERA proxy
            "home_sp_era_proxy", "away_sp_era_proxy", "sp_era_diff", "sp_winrate_diff",
            # New features
            "h2h_home_win_rate", "venue_win_rate_diff", "streak_diff", "off_eff_diff_3", "def_eff_diff_3",
        ]
    # fallback
    return [
        "home_scored_5", "away_scored_5", "home_allowed_5", "away_allowed_5",
        "pace_proxy_5", "off_eff_diff", "def_eff_diff",
        "rest_diff", "b2b_diff", "injury_diff", "sentiment_diff",
        "standing_rank_diff", "standing_win_pct_diff", "standing_gd_diff",
    ]


def _implied_prob(odds: float) -> float:
    """Convert decimal odds to implied probability."""
    if not odds or odds <= 1:
        return 0.5
    return 1.0 / odds


def _confidence_tier(edge: float) -> str:
    if edge >= 0.08:
        return "Strong"
    if edge >= 0.05:
        return "Moderate"
    return "Lean"


def _score_totals(game: dict, feat_row: dict, sport: str) -> dict | None:
    """
    Score the Over/Under total for a game using expected combined scoring.

    Approach:
    - Estimate expected total from rolling averages: home_scored_5 + away_scored_5
      (these are from the feature row — last-5 avg goals/points scored per team)
    - Compare to the market's posted total line
    - Use Poisson-style edge: if expected total deviates meaningfully from the line,
      and the market implied prob has value, flag it.

    For soccer: threshold is 0.3 goals deviation from line (meaningful gap).
    For NBA/MLB: threshold is 3 points/runs deviation.

    Returns a pick dict if edge >= MIN_EDGE, else None.
    """
    total_line = game.get("total_line")
    over_odds  = game.get("over_odds")
    under_odds = game.get("under_odds")

    if not total_line or not over_odds or not under_odds:
        return None
    if over_odds <= 1.0 or under_odds <= 1.0:
        return None

    # Expected total from rolling averages
    h_avg = feat_row.get("home_scored_5", 1.3)
    a_avg = feat_row.get("away_scored_5", 1.3)
    expected_total = h_avg + a_avg

    # Sport-specific scale check
    # Soccer goals: expected ~2.5, line ~2.5 — deviation of 0.3+ is meaningful
    # NBA points: expected ~220, line ~220 — deviation of 4+ is meaningful
    # MLB runs: expected ~9, line ~9 — deviation of 1.0+ is meaningful
    if sport == "soccer":
        deviation_threshold = 0.30
    elif sport == "nba":
        deviation_threshold = 4.0
    else:  # mlb
        deviation_threshold = 1.0

    deviation = expected_total - float(total_line)

    # Pick the direction with value
    if abs(deviation) < deviation_threshold:
        return None  # expected total too close to line — no edge

    side = "over" if deviation > 0 else "under"
    pick_odds = over_odds if side == "over" else under_odds

    # Model implied probability: use a logistic curve centered on deviation magnitude
    # More deviation = higher confidence. Calibrated to give ~60% at threshold, ~75% at 2x threshold.
    import math
    confidence = 0.5 + 0.5 * (1 - math.exp(-abs(deviation) / deviation_threshold * 0.7))
    implied_p  = _implied_prob(pick_odds)
    edge       = confidence - implied_p

    if edge < MIN_EDGE:
        return None

    # Human-friendly label
    if sport == "soccer":
        market_label = f"Over {total_line} goals" if side == "over" else f"Under {total_line} goals"
        bet_team_label = f"Over {total_line}" if side == "over" else f"Under {total_line}"
    elif sport == "nba":
        market_label = f"Over {total_line} pts" if side == "over" else f"Under {total_line} pts"
        bet_team_label = f"Over {total_line}" if side == "over" else f"Under {total_line}"
    else:
        market_label = f"Over {total_line} runs" if side == "over" else f"Under {total_line} runs"
        bet_team_label = f"Over {total_line}" if side == "over" else f"Under {total_line}"

    return {
        "game_id":          f"{game.get('home_team')}_{game.get('away_team')}_{game.get('date', '')}_totals",
        "sport":            sport,
        "league":           game.get("league", ""),
        "home_team":        game.get("home_team", ""),
        "away_team":        game.get("away_team", ""),
        "date":             str(game.get("date", "")),
        "venue":            game.get("venue", ""),
        "market":           "totals",
        "market_label":     market_label,
        "bet_side":         side,
        "bet_team":         bet_team_label,
        "total_line":       total_line,
        "expected_total":   round(expected_total, 2),
        "deviation":        round(deviation, 2),
        "model_prob":       round(confidence, 4),
        "implied_prob":     round(implied_p, 4),
        "edge":             round(edge, 4),
        "odds":             round(pick_odds, 3),
        "tier":             _confidence_tier(edge),
        "home_form":        round(h_avg, 2),
        "away_form":        round(a_avg, 2),
        "rank_diff":        round(feat_row.get("standing_rank_diff", 0), 1),
        "win_pct_diff":     round(feat_row.get("standing_win_pct_diff", 0), 3),
        "odds_source":      game.get("odds_source", "simulated"),
        "over_odds":        over_odds,
        "under_odds":       under_odds,
        "totals_bk":        game.get("totals_bk"),
        # no FD/DK individual fields for totals — they share the same line usually
        "home_fanduel":     None,
        "away_fanduel":     None,
        "home_draftkings":  None,
        "away_draftkings":  None,
        "home_bk":          None,
        "away_bk":          None,
    }


def _score_draw(game: dict, prob_home: float, feat_row: dict) -> dict | None:
    """
    Score the Draw market for a soccer game.

    Approach:
    - Draw probability is estimated from the model home-win probability.
      When prob_home is near 0.5 (balanced game), draw is more likely.
      We use a simple tent function: draw_prob peaks at prob_home ≈ 0.35-0.45
      (because soccer draws are more likely when away side has slight edge or even).
    - Compare to market implied draw probability from draw_odds.
    - If edge ≥ MIN_EDGE, return a pick.

    Only for soccer (draw is not a market in NBA/MLB).
    """
    draw_odds = game.get("draw_odds")
    if not draw_odds or draw_odds <= 1.0:
        return None

    # Estimate draw probability using a bell-curve centred on prob_home=0.38
    # (empirically draws peak when neither side is a heavy favourite)
    import math
    centre = 0.38
    width  = 0.18
    prob_draw = 0.30 * math.exp(-((prob_home - centre) ** 2) / (2 * width ** 2))
    prob_draw = min(max(prob_draw, 0.05), 0.40)

    imp_draw = _implied_prob(draw_odds)
    edge = prob_draw - imp_draw

    if edge < MIN_EDGE:
        return None

    return {
        "game_id":       f"{game.get('home_team')}_{game.get('away_team')}_{game.get('date', '')}_draw",
        "sport":         "soccer",
        "league":        game.get("league", ""),
        "home_team":     game.get("home_team", ""),
        "away_team":     game.get("away_team", ""),
        "date":          str(game.get("date", "")),
        "venue":         game.get("venue", ""),
        "market":        "draw",
        "market_label":  "Draw",
        "bet_side":      "draw",
        "bet_team":      "Draw",
        "model_prob":    round(prob_draw, 4),
        "implied_prob":  round(imp_draw, 4),
        "edge":          round(edge, 4),
        "odds":          round(draw_odds, 3),
        "tier":          _confidence_tier(edge),
        "home_form":     round(feat_row.get("home_scored_5", 0), 2),
        "away_form":     round(feat_row.get("away_scored_5", 0), 2),
        "rank_diff":     round(feat_row.get("standing_rank_diff", 0), 1),
        "win_pct_diff":  round(feat_row.get("standing_win_pct_diff", 0), 3),
        "odds_source":   game.get("odds_source", "simulated"),
        "draw_odds":     draw_odds,
        "draw_fanduel":  game.get("draw_fanduel"),
        "draw_draftkings": game.get("draw_draftkings"),
        "draw_bk":       game.get("draw_bk"),
        "home_odds":     game.get("home_odds"),
        "away_odds":     game.get("away_odds"),
        # Null for non-applicable fields
        "home_fanduel":    None,
        "away_fanduel":    None,
        "home_draftkings": None,
        "away_draftkings": None,
        "home_bk":         None,
        "away_bk":         None,
        "total_line":      None,
        "over_odds":       None,
        "under_odds":      None,
    }


# ---------------------------------------------------------------------------
# Main scorer
# ---------------------------------------------------------------------------

def _score_games_for_date(
    games: list[dict],
    hist: pd.DataFrame,
    standings_lookup: dict,
) -> list[dict]:
    """Score a list of game dicts and return ranked picks."""
    # Build real-odds lookup per sport (cached 15 min, uses The Odds API free tier)
    odds_lookups: dict[str, dict] = {}
    try:
        from sports_model.live_odds import build_odds_lookup, enrich_game_with_odds
        # Pre-fetch odds for each sport present in today's games
        sports_present = {_get_sport(g) for g in games}
        for sp in sports_present:
            odds_lookups[sp] = build_odds_lookup(sp)
        # Enrich all games with real odds before scoring
        enriched_games = []
        for g in games:
            sp = _get_sport(g)
            lk = odds_lookups.get(sp, {})
            enriched_games.append(enrich_game_with_odds(g, lk))
        games = enriched_games
    except Exception as exc:
        logger.warning("Live odds enrichment failed: %s", exc)

    moneyline_picks: list[dict] = []
    draw_picks:      list[dict] = []
    totals_picks:    list[dict] = []

    for game in games:
        sport = _get_sport(game)
        model = _load_model(sport)
        if model is None:
            continue

        team_index = _HIST_CACHE.get("team_index")
        feat_row = _build_feature_row(game, hist, standings_lookup, sport, team_index=team_index)
        features = _sport_features(sport)
        X = pd.DataFrame([{f: feat_row.get(f, 0.0) for f in features}])

        try:
            prob_home = float(model.predict_proba(X)[0][1])
        except Exception as exc:
            logger.warning("Model predict failed for %s: %s", game.get("home_team"), exc)
            continue

        prob_away = 1.0 - prob_home
        home_odds = float(game.get("home_odds") or 1.9090)
        away_odds = float(game.get("away_odds") or 1.9090)
        if home_odds <= 1.0: home_odds = 1.9090
        if away_odds <= 1.0: away_odds = 1.9090

        imp_home = _implied_prob(home_odds)
        imp_away = _implied_prob(away_odds)
        edge_home = prob_home - imp_home
        edge_away = prob_away - imp_away
        best_edge = max(edge_home, edge_away)

        # ── Moneyline pick ──
        if best_edge >= MIN_EDGE:
            bet_side   = "home" if edge_home >= edge_away else "away"
            bet_team   = game["home_team"] if bet_side == "home" else game["away_team"]
            bet_odds   = home_odds if bet_side == "home" else away_odds
            model_prob = prob_home if bet_side == "home" else prob_away

            moneyline_picks.append({
                "game_id":         f"{game.get('home_team')}_{game.get('away_team')}_{game.get('date', '')}",
                "sport":           sport,
                "league":          game.get("league", ""),
                "home_team":       game.get("home_team", ""),
                "away_team":       game.get("away_team", ""),
                "date":            str(game.get("date", "")),
                "venue":           game.get("venue", ""),
                "market":          "h2h",
                "market_label":    "Moneyline",
                "bet_side":        bet_side,
                "bet_team":        bet_team,
                "model_prob":      round(model_prob, 4),
                "implied_prob":    round(imp_home if bet_side == "home" else imp_away, 4),
                "edge":            round(best_edge, 4),
                "odds":            round(bet_odds, 3),
                "tier":            _confidence_tier(best_edge),
                "home_form":       round(feat_row["home_scored_5"], 2),
                "away_form":       round(feat_row["away_scored_5"], 2),
                "rank_diff":       round(feat_row["standing_rank_diff"], 1),
                "win_pct_diff":    round(feat_row["standing_win_pct_diff"], 3),
                "odds_source":     game.get("odds_source", "simulated"),
                "home_fanduel":    game.get("home_fanduel"),
                "away_fanduel":    game.get("away_fanduel"),
                "home_draftkings": game.get("home_draftkings"),
                "away_draftkings": game.get("away_draftkings"),
                "home_bk":         game.get("home_bk"),
                "away_bk":         game.get("away_bk"),
                "total_line":      game.get("total_line"),
                "over_odds":       game.get("over_odds"),
                "under_odds":      game.get("under_odds"),
            })

        # ── Draw pick (soccer only) ──
        if sport == "soccer":
            draw_pick = _score_draw(game, prob_home, feat_row)
            if draw_pick:
                draw_picks.append(draw_pick)

        # ── Totals pick (Over/Under) ──
        totals_pick = _score_totals(game, feat_row, sport)
        if totals_pick:
            totals_picks.append(totals_pick)

    # Sort each list by edge descending
    moneyline_picks.sort(key=lambda p: p["edge"], reverse=True)
    draw_picks.sort(key=lambda p: p["edge"], reverse=True)
    totals_picks.sort(key=lambda p: p["edge"], reverse=True)

    # Interleave: 2 moneylines → 1 draw → 1 total → repeat
    combined: list[dict] = []
    ml_idx = dr_idx = tot_idx = 0
    while ml_idx < len(moneyline_picks) or dr_idx < len(draw_picks) or tot_idx < len(totals_picks):
        for _ in range(2):
            if ml_idx < len(moneyline_picks):
                combined.append(moneyline_picks[ml_idx]); ml_idx += 1
        if dr_idx < len(draw_picks):
            combined.append(draw_picks[dr_idx]); dr_idx += 1
        if tot_idx < len(totals_picks):
            combined.append(totals_picks[tot_idx]); tot_idx += 1

    return combined


# Module-level cache for historical data and standings (TTL: 15 min)
_HIST_CACHE: dict = {}
_STANDINGS_CACHE: dict = {}
_CACHE_TTL = 1800  # 30 minutes — matches live_odds.py CACHE_TTL


def _build_team_index(hist: pd.DataFrame) -> dict:
    """
    Pre-index historical data by team for O(1) feature lookups.
    Returns {team: sorted_df} for every team that appears in hist.
    Each df contains all games (home + away) for that team, sorted by date.
    """
    index: dict[str, pd.DataFrame] = {}
    if hist.empty:
        return index
    all_teams = set(hist["home_team"].dropna().unique()) | set(hist["away_team"].dropna().unique())
    for team in all_teams:
        mask = (hist["home_team"] == team) | (hist["away_team"] == team)
        index[team] = hist[mask].sort_values("date").reset_index(drop=True)
    return index


def _load_hist_and_standings():
    import time
    from sports_model.standings import fetch_all_standings, build_standings_lookup

    now = time.time()

    # Historical CSV — cache indefinitely per process (only changes after retraining)
    if "hist" not in _HIST_CACHE:
        hist = pd.DataFrame()
        hist_path = DATA_DIR / "historical_games.csv"
        if hist_path.exists():
            hist = pd.read_csv(hist_path, parse_dates=["date"])
            hist = hist.dropna(subset=["home_score", "away_score"])
        _HIST_CACHE["hist"] = hist
        _HIST_CACHE["team_index"] = _build_team_index(hist)
        logger.info("Loaded historical_games.csv: %d rows, %d teams indexed", len(hist), len(_HIST_CACHE["team_index"]))

    # Standings — refresh every 15 minutes
    if "lookup" not in _STANDINGS_CACHE or now - _STANDINGS_CACHE.get("ts", 0) > _CACHE_TTL:
        try:
            standings_df = fetch_all_standings()
            _STANDINGS_CACHE["lookup"] = build_standings_lookup(standings_df)
            _STANDINGS_CACHE["ts"] = now
            logger.info("Standings refreshed: %d teams", len(_STANDINGS_CACHE["lookup"]))
        except Exception as exc:
            logger.warning("Standings fetch failed: %s", exc)
            if "lookup" not in _STANDINGS_CACHE:
                _STANDINGS_CACHE["lookup"] = {}

    return _HIST_CACHE["hist"], _STANDINGS_CACHE["lookup"]


_FINAL_STATUSES = {
    "STATUS_FINAL", "STATUS_FULL_TIME", "Final",
    "STATUS_FINAL_AET", "STATUS_FINAL_PEN",
}


def _build_parlay(picks: list[dict]) -> dict | None:
    """Build a parlay suggestion dict from the top Strong/Moderate picks."""
    candidates = [p for p in picks if p.get("tier") in ("Strong", "Moderate")][:3]
    if len(candidates) < 2:
        return None
    combined_odds = 1.0
    for p in candidates:
        combined_odds *= p["odds"]
    return {
        "legs": [{"team": p["bet_team"], "odds": p["odds"], "tier": p["tier"]} for p in candidates],
        "combined_odds": round(combined_odds, 2),
        "implied_prob":  round(1.0 / combined_odds, 4),
    }


def score_todays_games(
    hist_path: Path = DATA_DIR / "historical_games.csv",
    top_n: int = 8,
) -> list[dict]:
    """Score today's upcoming games and return ranked picks with edge/tier."""
    from sports_model.espn_ingest import fetch_live_scoreboard
    hist, standings_lookup = _load_hist_and_standings()
    try:
        scoreboard = fetch_live_scoreboard()
        games = scoreboard.to_dict(orient="records") if not scoreboard.empty else []
    except Exception as exc:
        logger.warning("Scoreboard fetch failed: %s", exc)
        games = []
    upcoming = [
        g for g in games
        if g.get("status") not in _FINAL_STATUSES
        and g.get("home_team") and g.get("away_team")
    ]
    return _score_games_for_date(upcoming, hist, standings_lookup)[:top_n]


def _winner_tier(prob: float) -> str:
    if prob >= 0.67:
        return "Strong"
    if prob >= 0.60:
        return "Moderate"
    return "Lean"


def _score_winner_probs_for_date(
    games: list[dict],
    hist: pd.DataFrame,
    standings_lookup: dict,
) -> list[dict]:
    """Score games for straight-up winner probability recommendations (no edge filter)."""
    picks: list[dict] = []

    for game in games:
        sport = _get_sport(game)
        model = _load_model(sport)
        if model is None:
            continue

        team_index = _HIST_CACHE.get("team_index")
        feat_row = _build_feature_row(game, hist, standings_lookup, sport, team_index=team_index)
        features = _sport_features(sport)
        X = pd.DataFrame([{f: feat_row.get(f, 0.0) for f in features}])

        try:
            prob_home = float(model.predict_proba(X)[0][1])
        except Exception as exc:
            logger.warning("Winner predict failed for %s vs %s: %s", game.get("home_team"), game.get("away_team"), exc)
            continue

        prob_away = 1.0 - prob_home
        bet_side = "home" if prob_home >= prob_away else "away"
        bet_team = game.get("home_team", "") if bet_side == "home" else game.get("away_team", "")
        win_prob = prob_home if bet_side == "home" else prob_away

        home_odds = float(game.get("home_odds") or 0)
        away_odds = float(game.get("away_odds") or 0)
        odds = home_odds if bet_side == "home" else away_odds

        picks.append({
            "game_id":         f"{game.get('home_team')}_{game.get('away_team')}_{game.get('date', '')}",
            "sport":           sport,
            "league":          game.get("league", ""),
            "home_team":       game.get("home_team", ""),
            "away_team":       game.get("away_team", ""),
            "date":            str(game.get("date", "")),
            "venue":           game.get("venue", ""),
            "market":          "h2h",
            "market_label":    "Winner",
            "bet_side":        bet_side,
            "bet_team":        bet_team,
            "recommended_winner": bet_team,
            "model_prob":      round(win_prob, 4),
            "win_probability": round(win_prob, 4),
            "model_prob_home": round(prob_home, 4),
            "model_prob_away": round(prob_away, 4),
            "confidence":      round(abs(prob_home - prob_away), 4),
            "tier":            _winner_tier(win_prob),
            "odds":            round(odds, 3) if odds and odds > 1 else None,
            "home_form":       round(feat_row.get("home_scored_5", 0), 2),
            "away_form":       round(feat_row.get("away_scored_5", 0), 2),
            "rank_diff":       round(feat_row.get("standing_rank_diff", 0), 1),
            "win_pct_diff":    round(feat_row.get("standing_win_pct_diff", 0), 3),
        })

    picks.sort(key=lambda p: p.get("win_probability", 0), reverse=True)
    return picks


def score_todays_winners(top_n: int = 10) -> list[dict]:
    from sports_model.espn_ingest import fetch_live_scoreboard
    hist, standings_lookup = _load_hist_and_standings()
    try:
        scoreboard = fetch_live_scoreboard()
        games = scoreboard.to_dict(orient="records") if not scoreboard.empty else []
    except Exception as exc:
        logger.warning("Winner scoreboard fetch failed: %s", exc)
        games = []

    upcoming = [
        g for g in games
        if g.get("status") not in _FINAL_STATUSES
        and g.get("home_team") and g.get("away_team")
    ]
    return _score_winner_probs_for_date(upcoming, hist, standings_lookup)[:top_n]


def score_tomorrows_winners(top_n: int = 10) -> list[dict]:
    from datetime import timedelta
    from sports_model.espn_ingest import ESPN_LEAGUES, fetch_espn_scoreboard, fetch_mlb_scoreboard

    tomorrow = date.today() + timedelta(days=1)
    hist, standings_lookup = _load_hist_and_standings()
    games: list[dict] = []

    for slug in ESPN_LEAGUES:
        try:
            rows = fetch_espn_scoreboard(slug, game_date=tomorrow)
            games.extend(rows)
        except Exception as exc:
            logger.warning("Tomorrow winners scoreboard failed for %s: %s", slug, exc)
    try:
        games.extend(fetch_mlb_scoreboard(game_date=tomorrow))
    except Exception as exc:
        logger.warning("Tomorrow winners MLB scoreboard failed: %s", exc)

    upcoming = [g for g in games if g.get("home_team") and g.get("away_team")]
    return _score_winner_probs_for_date(upcoming, hist, standings_lookup)[:top_n]


def score_tomorrows_games(top_n: int = 8) -> list[dict]:
    """Score tomorrow's scheduled games across all ESPN leagues + MLB."""
    from datetime import timedelta
    from sports_model.espn_ingest import ESPN_LEAGUES, fetch_espn_scoreboard, fetch_mlb_scoreboard
    tomorrow = date.today() + timedelta(days=1)
    hist, standings_lookup = _load_hist_and_standings()
    games: list[dict] = []
    for slug in ESPN_LEAGUES:
        try:
            rows = fetch_espn_scoreboard(slug, game_date=tomorrow)
            games.extend(rows)
        except Exception as exc:
            logger.warning("Tomorrow scoreboard failed %s: %s", slug, exc)
    try:
        games.extend(fetch_mlb_scoreboard(game_date=tomorrow))
    except Exception as exc:
        logger.warning("Tomorrow MLB failed: %s", exc)
    upcoming = [g for g in games if g.get("home_team") and g.get("away_team")]
    return _score_games_for_date(upcoming, hist, standings_lookup)[:top_n]


def build_recommendations_tomorrow(top_n: int = 8) -> dict:
    """
    Full pipeline for tomorrow's slate: score → Gemini narrative → return dict.
    Same structure as build_recommendations() but for tomorrow's games.
    """
    from datetime import timedelta
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    picks = score_tomorrows_games(top_n=top_n)

    if not picks:
        return {
            "date":       tomorrow,
            "picks":      [],
            "parlay":     None,
            "ai_summary": "No picks with sufficient edge found for tomorrow's slate.",
            "model_note": (
                "Edge = model probability minus market implied probability. "
                "Min edge threshold: 3%. ESPN may not have published full tomorrow schedule yet."
            ),
        }

    def _pick_summary_tmrw(i: int, p: dict) -> str:
        market = p.get("market", "h2h")
        if market == "totals":
            return (
                f"{i+1}. {p['bet_team']} | {p['home_team']} vs {p['away_team']} "
                f"| {p['league']} | Market: O/U Total "
                f"| Line: {p.get('total_line')} | Expected total: {p.get('expected_total')} "
                f"| Deviation: {p.get('deviation'):+.2f} | Model conf: {p['model_prob']*100:.1f}% "
                f"| Market implied: {p['implied_prob']*100:.1f}% | Edge: {p['edge']*100:.1f}% "
                f"| Odds: {p['odds']} | Tier: {p['tier']}"
            )
        opponent = p['away_team'] if p['bet_side'] == 'home' else p['home_team']
        return (
            f"{i+1}. {p['bet_team']} (MONEYLINE) vs {opponent} "
            f"| {p['league']} | Sport: {p['sport'].upper()} "
            f"| Model prob: {p['model_prob']*100:.1f}% | Market implied: {p['implied_prob']*100:.1f}% "
            f"| Edge: {p['edge']*100:.1f}% | Odds: {p['odds']} | Tier: {p['tier']} "
            f"| Odds source: {p.get('odds_source','simulated')} "
            f"| Home avg scored (last 5): {p['home_form']} | Away avg scored (last 5): {p['away_form']} "
            f"| Rank diff (away-home): {p['rank_diff']}"
        )

    picks_text = "\n".join([_pick_summary_tmrw(i, p) for i, p in enumerate(picks)])

    parlay_candidates = [p for p in picks if p["tier"] in ("Strong", "Moderate")][:3]
    parlay_text = ""
    if len(parlay_candidates) >= 2:
        legs = " + ".join([f"{p['bet_team']} ({p['odds']})" for p in parlay_candidates])
        combined_odds = 1.0
        for p in parlay_candidates:
            combined_odds *= p["odds"]
        parlay_text = f"\nSuggested parlay legs: {legs} → combined odds: {combined_odds:.2f}"

    prompt = f"""You are a sharp sports betting analyst. Tomorrow's date is {tomorrow}.

Our machine learning model identified the following value bets for tomorrow's slate.
Edge = model probability minus de-vigged market implied probability (minimum 3% required).

TOMORROW'S PICKS:
{picks_text}
{parlay_text}

Your task:
1. For each pick, write 2-3 sharp, specific sentences explaining WHY this is a good bet — reference the edge size, team form, matchup dynamics, standings, and what the odds imply vs what our model thinks.
2. Explain any meaningful risk factors or caveats for each pick.
3. If there are 2+ parlay candidates, recommend whether to parlay them and explain the reasoning.
4. Rate your overall confidence in tomorrow's slate (Low / Medium / High) and briefly explain.
5. End with a one-line responsible gambling disclaimer.

Be analytical and honest. Do NOT hype picks. Do NOT invent stats. Use the numbers provided.
Keep response under 500 words. Use the exact same numbering as above."""

    ai_text = _call_gemini(prompt)

    parlay_obj = None
    if len(parlay_candidates) >= 2:
        combined_odds = 1.0
        for p in parlay_candidates:
            combined_odds *= p["odds"]
        parlay_obj = {
            "legs": [
                {"team": p["bet_team"], "odds": p["odds"], "tier": p["tier"]}
                for p in parlay_candidates
            ],
            "combined_odds": round(combined_odds, 2),
            "implied_prob":  round(1.0 / combined_odds, 4),
        }

    return {
        "date":       tomorrow,
        "picks":      picks,
        "parlay":     parlay_obj,
        "ai_summary": ai_text,
        "model_note": (
            "Edge = model probability minus market-implied probability (de-vigged). "
            f"Min edge: {MIN_EDGE*100:.0f}%. Model trained on 6,429 real games (soccer/NBA/MLB)."
        ),
    }


# ---------------------------------------------------------------------------
# Gemini narrative layer
# ---------------------------------------------------------------------------

def _call_gemini(prompt: str) -> str:
    """Call Gemini 2.5 Flash and return the text response."""
    if not GEMINI_API_KEY:
        return "Gemini API key not configured."
    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        return response.text or ""
    except Exception as exc:
        logger.error("Gemini call failed: %s", exc)
        return f"AI narrative unavailable: {exc}"


def build_recommendations(top_n: int = 8) -> dict:
    """
    Full pipeline: score today's games → Gemini narrative → return dict.
    """
    today = date.today().isoformat()
    picks = score_todays_games(top_n=top_n)

    if not picks:
        return {
            "date": today,
            "picks": [],
            "parlay": None,
            "ai_summary": "No picks with sufficient edge found for today's slate.",
            "model_note": (
                "Edge = model probability minus market implied probability. "
                "Min edge threshold: 3%. Picks ranked by edge size."
            ),
        }

    # Build prompt for Gemini
    def _pick_summary(i: int, p: dict) -> str:
        market = p.get("market", "h2h")
        if market == "totals":
            return (
                f"{i+1}. {p['bet_team']} | {p['home_team']} vs {p['away_team']} "
                f"| {p['league']} | Market: O/U Total "
                f"| Line: {p.get('total_line')} | Expected total: {p.get('expected_total')} "
                f"| Deviation: {p.get('deviation'):+.2f} | Model conf: {p['model_prob']*100:.1f}% "
                f"| Market implied: {p['implied_prob']*100:.1f}% | Edge: {p['edge']*100:.1f}% "
                f"| Odds: {p['odds']} | Tier: {p['tier']}"
            )
        opponent = p['away_team'] if p['bet_side'] == 'home' else p['home_team']
        return (
            f"{i+1}. {p['bet_team']} (MONEYLINE) vs {opponent} "
            f"| {p['league']} | Model: {p['model_prob']*100:.1f}% "
            f"| Implied: {p['implied_prob']*100:.1f}% | Edge: {p['edge']*100:.1f}% "
            f"| Odds: {p['odds']} | Tier: {p['tier']} "
            f"| Avg scored last 5: H {p['home_form']} / A {p['away_form']}"
        )

    picks_text = "\n".join([_pick_summary(i, p) for i, p in enumerate(picks)])

    parlay_candidates = [p for p in picks if p["tier"] in ("Strong", "Moderate")][:3]
    parlay_text = ""
    if len(parlay_candidates) >= 2:
        legs = " + ".join([f"{p['bet_team']} ({p['odds']})" for p in parlay_candidates])
        combined_odds = 1.0
        for p in parlay_candidates:
            combined_odds *= p["odds"]
        parlay_text = f"\nSuggested parlay legs: {legs} → combined odds: {combined_odds:.2f}"

    prompt = f"""You are a sharp sports betting analyst. Today is {today}.

Our machine learning model has identified the following value bets for today's slate.
The model uses rolling form, standings data, and historical match patterns.
Edge = model probability minus market implied probability (minimum 3% required).

TOP PICKS:
{picks_text}
{parlay_text}

Your task:
1. For each pick, write 1-2 sentences of sharp, specific reasoning (reference the data: form, standings, edge size). Be honest about uncertainty.
2. If there are 2+ parlay candidates, confirm or adjust the parlay suggestion and explain why those legs combine well.
3. End with a one-line disclaimer about gambling risk.

Keep the total response concise (under 400 words). Use the exact same numbering as above.
Do NOT invent statistics not provided. Be direct and analytical, not hype-y."""

    ai_text = _call_gemini(prompt)

    # Build parlay object
    parlay_obj = None
    if len(parlay_candidates) >= 2:
        combined_odds = 1.0
        for p in parlay_candidates:
            combined_odds *= p["odds"]
        parlay_obj = {
            "legs": [
                {"team": p["bet_team"], "odds": p["odds"], "tier": p["tier"]}
                for p in parlay_candidates
            ],
            "combined_odds": round(combined_odds, 2),
            "implied_prob":  round(1.0 / combined_odds, 4),
        }

    hist_count = len(_HIST_CACHE.get("hist", pd.DataFrame()))
    result = {
        "date":       today,
        "picks":      picks,
        "parlay":     parlay_obj,
        "ai_summary": ai_text,
        "model_note": (
            "Edge = model probability minus market-implied probability (de-vigged). "
            f"Min edge: {MIN_EDGE*100:.0f}%. Model trained on {hist_count} real games (soccer/NBA/MLB). "
            "Yields shown are from simulated-odds backtest — treat as directional only."
        ),
    }

    # Auto-log picks for W/R tracking
    try:
        from sports_model.prediction_log import log_picks
        log_picks(picks, pick_date=today)
    except Exception as exc:
        logger.warning("prediction_log failed: %s", exc)

    return result
