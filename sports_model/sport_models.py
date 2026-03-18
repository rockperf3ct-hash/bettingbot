"""
Sport-specific model training and inference.

Instead of one mixed model, trains separate HistGradientBoosting models for:
  - soccer  (EPL, Bundesliga, LaLiga, Liga MX, UCL, Europa League)
  - nba
  - mlb

Each sport gets its own feature subset, walk-forward validation,
and saved model artifact. Results are merged into a unified
multi_model_benchmark.json for the dashboard.

Public API
----------
train_all_sport_models(data_path, out_dir) -> dict
    Reads historical_games.csv, splits by sport, trains each,
    saves per-sport artifacts, returns combined summary.

predict_sport(sport, X) -> np.ndarray
    Loads the saved sport model and returns home-win probabilities.
"""

from __future__ import annotations

import json
import logging
import os
from typing import cast

import joblib
import numpy as np
import pandas as pd

from sports_model.backtest import run_backtest, save_backtest_summary
from sports_model.config import settings
from sports_model.features import build_features
from sports_model.modeling import (
    benchmark_models,
    oos_walk_forward_predictions,
    save_metrics,
    save_model,
    train_final_model,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Sport routing
# ---------------------------------------------------------------------------

SPORT_LEAGUE_MAP: dict[str, list[str]] = {
    "soccer": ["EPL", "Bundesliga", "LaLiga", "Liga MX", "UCL", "Europa League"],
    "nba":    ["NBA"],
    "mlb":    ["MLB"],
}

# Feature subsets per sport — use only what makes sense for each
SOCCER_FEATURES = [
    # 5-game form
    "home_scored_5", "away_scored_5", "home_allowed_5", "away_allowed_5",
    "pace_proxy_5", "off_eff_diff", "def_eff_diff",
    # 10-game form (medium-term)
    "home_scored_10", "away_scored_10", "home_allowed_10", "away_allowed_10",
    "pace_proxy_10", "off_eff_diff_10", "def_eff_diff_10",
    # 20-game baseline
    "home_scored_20", "away_scored_20", "home_allowed_20", "away_allowed_20",
    "off_eff_diff_20", "def_eff_diff_20",
    # Real rest features
    "rest_diff", "rest_home", "rest_away", "home_fatigue", "away_fatigue", "fatigue_diff",
    "b2b_diff",
    # Form momentum
    "form_rate_diff", "form_momentum_diff",
    # Context
    "injury_diff", "sentiment_diff",
    "weather_temp_c", "weather_wind_kph",
    # Standings
    "standing_rank_diff", "standing_win_pct_diff", "standing_gd_diff", "standing_pts_diff",
    # Soccer-specific
    "shot_acc_diff", "shot_acc_diff_10", "sot_diff", "possession_diff", "corners_diff",
    # New: H2H, venue split, streak, last-3
    "h2h_home_win_rate", "venue_win_rate_diff", "streak_diff", "off_eff_diff_3", "def_eff_diff_3",
]

NBA_FEATURES = [
    # 5-game form
    "home_scored_5", "away_scored_5", "home_allowed_5", "away_allowed_5",
    "pace_proxy_5", "off_eff_diff", "def_eff_diff",
    # 10-game form
    "home_scored_10", "away_scored_10", "home_allowed_10", "away_allowed_10",
    "pace_proxy_10", "off_eff_diff_10", "def_eff_diff_10",
    # 20-game baseline
    "home_scored_20", "away_scored_20", "home_allowed_20", "away_allowed_20",
    "off_eff_diff_20", "def_eff_diff_20",
    # Real rest features (critical for NBA — back-to-backs are very common)
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
    # New: H2H, venue split, streak, last-3
    "h2h_home_win_rate", "venue_win_rate_diff", "home_streak", "away_streak", "streak_diff",
    "off_eff_diff_3", "def_eff_diff_3",
]

MLB_FEATURES = [
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
    "injury_diff", "sentiment_diff",
    "weather_temp_c", "weather_wind_kph",
    # Standings
    "standing_rank_diff", "standing_win_pct_diff",
    # MLB-specific
    "hits_diff", "hits_diff_10", "errors_diff",
    # Pitcher features (rolling ERA proxy + win rate)
    "home_sp_era_proxy", "away_sp_era_proxy", "sp_era_diff", "sp_winrate_diff",
    # New: H2H, venue split, streak, last-3
    "h2h_home_win_rate", "venue_win_rate_diff", "streak_diff", "off_eff_diff_3", "def_eff_diff_3",
]

SPORT_FEATURES: dict[str, list[str]] = {
    "soccer": SOCCER_FEATURES,
    "nba":    NBA_FEATURES,
    "mlb":    MLB_FEATURES,
}

MIN_ROWS_TO_TRAIN = 200   # skip sport if too few samples


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sport_for_league(league: str) -> str | None:
    for sport, leagues in SPORT_LEAGUE_MAP.items():
        if league in leagues:
            return sport
    return None


def _filter_features(X: pd.DataFrame, sport: str) -> pd.DataFrame:
    wanted = SPORT_FEATURES.get(sport, list(X.columns))
    available = [c for c in wanted if c in X.columns]
    result = X[available].fillna(0.0)
    return result  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Per-sport training
# ---------------------------------------------------------------------------

def train_sport_model(
    sport: str,
    df_sport: pd.DataFrame,
    out_dir: str,
    n_splits: int = 5,
) -> dict:
    """
    Train, validate and backtest a model for one sport.
    Saves:
        {out_dir}/{sport}_model.joblib
        {out_dir}/{sport}_metrics.json
        {out_dir}/{sport}_benchmark.json
        {out_dir}/{sport}_backtest_bets.csv
        {out_dir}/{sport}_backtest_summary.json
    Returns summary dict.
    """
    logger.info("Training %s model on %d rows", sport, len(df_sport))

    X_raw, y_raw, meta_raw = build_features(df_sport)
    X_all  = cast(pd.DataFrame, X_raw)   # type: ignore[arg-type]
    y_all  = cast(pd.Series,    y_raw)   # type: ignore[arg-type]
    meta   = cast(pd.DataFrame, meta_raw)  # type: ignore[arg-type]

    X = _filter_features(X_all, sport)

    if len(X) < MIN_ROWS_TO_TRAIN:
        logger.warning("Skipping %s — only %d rows (< %d)", sport, len(X), MIN_ROWS_TO_TRAIN)
        return {"sport": sport, "skipped": True, "rows": len(X)}

    # Benchmark
    benchmark = benchmark_models(X, y_all, n_splits=n_splits)
    best_model = benchmark["best_model"]
    metrics    = benchmark["models"][best_model]

    # OOS predictions for backtest
    oos_pred = oos_walk_forward_predictions(X, y_all, model_name=best_model, n_splits=n_splits)

    # Final model on all data
    model = train_final_model(X, y_all, model_name=best_model)

    # Backtest
    valid_mask   = pd.Series(oos_pred).notna().to_numpy()
    backtest_meta = meta.loc[valid_mask].reset_index(drop=True)
    backtest_pred = oos_pred[valid_mask]

    bets, summary = run_backtest(
        meta=backtest_meta,
        pred_home_win_prob=backtest_pred,
        bankroll_start=settings.bankroll_start,
        min_edge=settings.min_edge,
        kelly_fraction_scale=settings.kelly_fraction,
        max_bet_pct=settings.max_bet_pct,
    )
    summary["sport"] = sport
    summary["rows"]  = int(len(df_sport))
    summary["best_model"] = best_model
    summary["avg_roc_auc"] = metrics.get("avg_roc_auc")
    summary["avg_log_loss"] = metrics.get("avg_log_loss")
    summary["features_used"] = list(X.columns)

    # Save
    save_model(model,    os.path.join(out_dir, f"{sport}_model.joblib"))
    save_metrics(metrics,   os.path.join(out_dir, f"{sport}_metrics.json"))
    save_metrics(benchmark, os.path.join(out_dir, f"{sport}_benchmark.json"))
    bets.to_csv(os.path.join(out_dir, f"{sport}_backtest_bets.csv"), index=False)
    save_backtest_summary(summary, os.path.join(out_dir, f"{sport}_backtest_summary.json"))

    logger.info(
        "%s: best=%s auc=%.3f bets=%d hit=%.3f yield=%.3f",
        sport, best_model,
        summary.get("avg_roc_auc") or 0,
        summary["bets_placed"],
        summary["hit_rate"],
        summary["yield"],
    )
    return summary


# ---------------------------------------------------------------------------
# Train all sports
# ---------------------------------------------------------------------------

def train_all_sport_models(data_path: str, out_dir: str, n_splits: int = 5) -> dict:
    """
    Load historical_games.csv, split by sport, train each sport model,
    save a combined multi_model_summary.json.

    Returns
    -------
    dict with keys: sports (list of per-sport summaries), out_dir
    """
    os.makedirs(out_dir, exist_ok=True)

    raw = pd.read_csv(data_path)

    # Tag each row with its sport
    raw["_sport"] = raw["league"].apply(_sport_for_league)
    unknown_leagues = list(raw.loc[raw["_sport"].isna(), "league"].unique())
    if unknown_leagues:
        logger.warning("Unknown leagues (will be skipped): %s", unknown_leagues)

    summaries: list[dict] = []
    for sport in SPORT_LEAGUE_MAP:
        df_sport: pd.DataFrame = raw[raw["_sport"] == sport].drop(columns=["_sport"]).copy()  # type: ignore[assignment]
        if df_sport.empty:
            logger.warning("No data for sport: %s", sport)
            summaries.append({"sport": sport, "skipped": True, "rows": 0})
            continue
        summary = train_sport_model(sport, df_sport, out_dir, n_splits=n_splits)
        summaries.append(summary)

    combined = {
        "sports": summaries,
        "out_dir": out_dir,
    }
    with open(os.path.join(out_dir, "multi_model_summary.json"), "w") as f:
        json.dump(combined, f, indent=2)

    return combined


# ---------------------------------------------------------------------------
# Inference helper
# ---------------------------------------------------------------------------

def predict_sport(sport: str, X: pd.DataFrame, artifacts_dir: str = "artifacts") -> np.ndarray:
    """
    Load the saved sport-specific model and return home-win probabilities.

    Parameters
    ----------
    sport : "soccer" | "nba" | "mlb"
    X     : feature DataFrame (will be filtered to sport's feature subset)
    artifacts_dir : where {sport}_model.joblib was saved

    Returns
    -------
    np.ndarray of shape (n,) with P(home_win)
    """
    model_path = os.path.join(artifacts_dir, f"{sport}_model.joblib")
    if not os.path.exists(model_path):
        raise FileNotFoundError(
            f"No model found at {model_path}. "
            f"Run 'python run.py sport-models' first."
        )
    model = joblib.load(model_path)
    X_filtered = _filter_features(X, sport)
    return model.predict_proba(X_filtered)[:, 1]
