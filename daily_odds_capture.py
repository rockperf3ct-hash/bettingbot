"""
Daily odds capture script.

Fetches current odds snapshots from The Odds API for all supported
sport keys and appends them to data/odds_snapshots.csv.

Designed to be run once per day via Windows Task Scheduler.

Usage:
    python daily_odds_capture.py
    python daily_odds_capture.py --out data/odds_snapshots.csv
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/daily_odds_capture.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# All sport keys we want to capture odds for
SPORT_KEYS = [
    # Soccer
    "soccer_epl",
    "soccer_germany_bundesliga",
    "soccer_spain_la_liga",
    "soccer_mexico_ligamx",
    "soccer_uefa_champs_league",
    "soccer_uefa_europa_league",
    # Basketball
    "basketball_nba",
    # Baseball
    "baseball_mlb",
]

REGIONS = "us,uk"
MARKETS = "h2h"


def capture_all_odds(out_path: str) -> dict:
    """Capture odds for all sport keys, append to CSV. Returns summary."""
    from sports_model.datasets import save_odds_snapshot

    Path("logs").mkdir(exist_ok=True)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)

    results: dict[str, str] = {}
    total_rows = 0

    for sport_key in SPORT_KEYS:
        try:
            logger.info("Fetching odds: %s", sport_key)
            saved = save_odds_snapshot(
                sport_key=sport_key,
                out_path=out_path,
                region=REGIONS,
                market=MARKETS,
            )
            results[sport_key] = "ok"
            logger.info("  → saved to %s", saved)
            time.sleep(1.0)   # be polite, preserve quota
        except Exception as exc:
            logger.error("  → FAILED %s: %s", sport_key, exc)
            results[sport_key] = f"error: {exc}"

    # Count rows added today
    try:
        import pandas as pd
        df = pd.read_csv(out_path)
        today = datetime.utcnow().strftime("%Y-%m-%d")
        today_rows = df[df.get("snapshot_time", pd.Series(dtype=str)).str.startswith(today, na=False)]
        total_rows = len(today_rows)
    except Exception:
        pass

    summary = {
        "timestamp": datetime.utcnow().isoformat(),
        "sports_attempted": len(SPORT_KEYS),
        "sports_succeeded": sum(1 for v in results.values() if v == "ok"),
        "rows_added_today": total_rows,
        "results": results,
    }
    logger.info("Done: %d/%d sports succeeded", summary["sports_succeeded"], summary["sports_attempted"])
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily odds capture")
    parser.add_argument("--out", default="data/odds_snapshots.csv")
    args = parser.parse_args()

    summary = capture_all_odds(args.out)
    import json
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
