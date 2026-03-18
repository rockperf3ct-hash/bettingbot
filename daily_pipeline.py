"""
Full daily pipeline orchestrator.

Runs in sequence every day:
  1. Capture live odds snapshots (all sports)
  2. Fetch today's ESPN + MLB scoreboard  → append completed games
  3. Re-train sport-specific models on updated historical data
  4. Write updated artifacts for the dashboard

Designed to be called by Windows Task Scheduler via daily_pipeline.bat.

Usage:
    python daily_pipeline.py
    python daily_pipeline.py --skip-odds   # skip odds if quota is low
    python daily_pipeline.py --skip-train  # skip model re-train (fast run)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, timedelta
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/daily_pipeline.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

DATA_DIR      = Path("data")
ARTIFACTS_DIR = Path("artifacts")
LOGS_DIR      = Path("logs")

HISTORICAL_CSV  = DATA_DIR / "historical_games.csv"
ODDS_CSV        = DATA_DIR / "odds_snapshots.csv"


def step_capture_odds() -> dict:
    logger.info("=== STEP 1: Capture odds snapshots ===")
    from daily_odds_capture import capture_all_odds
    return capture_all_odds(str(ODDS_CSV))


def step_fetch_new_games() -> dict:
    """Fetch yesterday's completed games and append to historical CSV."""
    logger.info("=== STEP 2: Fetch yesterday's completed games ===")
    from sports_model.espn_ingest import (
        fetch_historical_games_fast,
        fetch_mlb_scoreboard,
        _is_completed,
    )
    import pandas as pd

    yesterday = date.today() - timedelta(days=1)

    # ESPN fast fetch (soccer + NBA)
    espn_df = fetch_historical_games_fast(
        start_date=yesterday,
        end_date=yesterday,
        leagues=["epl", "bundesliga", "laliga", "liga_mx", "ucl", "europa", "nba"],
        delay_seconds=0.3,
    )

    # MLB
    mlb_rows = fetch_mlb_scoreboard(game_date=yesterday)
    completed_mlb = [r for r in mlb_rows if _is_completed(r.get("status", ""))]
    mlb_df = pd.DataFrame(completed_mlb) if completed_mlb else pd.DataFrame()
    if not mlb_df.empty:
        mlb_df["date"] = pd.to_datetime(mlb_df["date"], utc=True, format="mixed")

    frames = [f for f in [espn_df, mlb_df] if not f.empty]
    new_games = 0
    if frames:
        new_df = pd.concat(frames, ignore_index=True)
        try:
            existing = pd.read_csv(HISTORICAL_CSV)
            combined = pd.concat([existing, new_df], ignore_index=True)
            combined = combined.drop_duplicates(subset=["date", "home_team", "away_team"])
            combined.to_csv(HISTORICAL_CSV, index=False)
            new_games = len(combined) - len(existing)
        except FileNotFoundError:
            new_df.to_csv(HISTORICAL_CSV, index=False)
            new_games = len(new_df)
        logger.info("Added %d new games for %s", new_games, yesterday)
    else:
        logger.info("No new completed games for %s", yesterday)

    return {"date": str(yesterday), "new_games": new_games}


def step_resolve_predictions() -> dict:
    """Auto-resolve yesterday's AI predictions against actual ESPN scores."""
    logger.info("=== STEP 2b: Resolve yesterday's AI predictions ===")
    try:
        from sports_model.prediction_log import resolve_date
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        result = resolve_date(yesterday)
        logger.info("  Resolved %d predictions: won=%d lost=%d push=%d not_found=%d",
                    result["resolved"], result["won"], result["lost"],
                    result["push"], result["not_found"])
        return result
    except Exception as exc:
        logger.warning("Prediction resolve failed: %s", exc)
        return {"error": str(exc)}


def step_log_todays_picks() -> dict:
    """Score today's games and log picks for future resolution."""
    logger.info("=== STEP 4: Log today's AI picks ===")
    try:
        from sports_model.recommendations import score_todays_games
        from sports_model.prediction_log import log_picks
        picks = score_todays_games(top_n=10)
        count = log_picks(picks)
        logger.info("  Logged %d picks for today", count)
        return {"logged": count}
    except Exception as exc:
        logger.warning("Pick logging failed: %s", exc)
        return {"error": str(exc)}


def step_send_discord_alert() -> dict:
    """Send today's top picks to Discord if webhook is configured."""
    logger.info("=== STEP 5: Send Discord alert ===")
    try:
        from sports_model.alerts import send_picks_alert
        sent = send_picks_alert(top_n=8)
        logger.info("  Discord alert sent: %s", sent)
        return {"sent": sent}
    except Exception as exc:
        logger.warning("Discord alert failed: %s", exc)
        return {"error": str(exc)}


def step_train_models() -> dict:
    """Re-train sport-specific models on updated data."""
    logger.info("=== STEP 3: Train sport-specific models ===")
    from sports_model.sport_models import train_all_sport_models

    ARTIFACTS_DIR.mkdir(exist_ok=True)
    result = train_all_sport_models(str(HISTORICAL_CSV), str(ARTIFACTS_DIR))

    for s in result.get("sports", []):
        if s.get("skipped"):
            logger.info("  %s: SKIPPED (%d rows)", s["sport"], s.get("rows", 0))
        else:
            logger.info(
                "  %s: auc=%.3f bets=%d hit=%.3f yield=%.3f",
                s["sport"],
                s.get("avg_roc_auc") or 0,
                s.get("bets_placed", 0),
                s.get("hit_rate", 0),
                s.get("yield", 0),
            )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily pipeline")
    parser.add_argument("--skip-odds",  action="store_true", help="Skip odds capture step")
    parser.add_argument("--skip-train", action="store_true", help="Skip model training step")
    args = parser.parse_args()

    LOGS_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)

    pipeline_result: dict = {"steps": {}}

    if not args.skip_odds:
        pipeline_result["steps"]["odds"] = step_capture_odds()
    else:
        logger.info("Skipping odds capture (--skip-odds)")

    pipeline_result["steps"]["games"]   = step_fetch_new_games()
    pipeline_result["steps"]["resolve"] = step_resolve_predictions()

    if not args.skip_train:
        pipeline_result["steps"]["models"] = step_train_models()
    else:
        logger.info("Skipping model training (--skip-train)")

    pipeline_result["steps"]["picks"]   = step_log_todays_picks()
    pipeline_result["steps"]["discord"] = step_send_discord_alert()

    logger.info("=== Daily pipeline complete ===")
    print(json.dumps(pipeline_result, indent=2, default=str))


if __name__ == "__main__":
    main()
