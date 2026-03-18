from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import date

from sports_model.automation import fetch_news_for_teams, fetch_weather_for_teams, run_daily_pipeline
from sports_model.config import settings
from sports_model.datasets import enrich_games_with_context, save_odds_snapshot
from sports_model.env_checks import env_report
from sports_model.espn_ingest import ESPN_LEAGUES, fetch_historical_games, fetch_historical_games_fast, fetch_live_scoreboard
from sports_model.standings import (
    ESPN_STANDINGS_LEAGUES,
    BL1_SEASONS,
    fetch_all_standings,
    fetch_espn_standings,
    fetch_openligadb_historical,
    fetch_teams_meta_bulk,
)
from sports_model.pipeline import full_run
from sports_model.simulate_data import write_sample_data
from sports_model.sport_models import SPORT_LEAGUE_MAP, train_all_sport_models

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sports prediction model runner")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate-sample", help="Generate sample historical dataset")
    gen.add_argument("--rows", type=int, default=2000)
    gen.add_argument("--seed", type=int, default=42)
    gen.add_argument("--out", type=str, default="data/historical_games.csv")

    run = sub.add_parser("full-run", help="Train, validate, and backtest (single mixed model)")
    run.add_argument("--data", type=str, required=True)
    run.add_argument("--out", type=str, default="artifacts")

    sport_run = sub.add_parser("sport-models", help="Train separate models per sport (soccer/NBA/MLB)")
    sport_run.add_argument("--data", type=str, default="data/historical_games.csv")
    sport_run.add_argument("--out",  type=str, default="artifacts")
    sport_run.add_argument("--splits", type=int, default=5, help="Walk-forward CV folds")

    odds = sub.add_parser("fetch-odds", help="Fetch and persist odds snapshots")
    odds.add_argument("--sport-key", type=str, required=True)
    odds.add_argument("--out", type=str, default="data/odds_snapshots.csv")
    odds.add_argument("--region", type=str, default=settings.odds_region)
    odds.add_argument("--market", type=str, default=settings.odds_market)
    odds.add_argument("--historical-date", type=str, default=None)

    enrich = sub.add_parser("enrich-data", help="Build point-in-time context features")
    enrich.add_argument("--games", type=str, required=True)
    enrich.add_argument("--out", type=str, default="data/enriched_games.csv")
    enrich.add_argument("--injuries", type=str, default=None)
    enrich.add_argument("--news", type=str, default=None)
    enrich.add_argument("--weather", type=str, default=None)
    enrich.add_argument("--line-snapshots", type=str, default=None)

    check = sub.add_parser("check-env", help="Check required API keys")
    check.add_argument("--json", action="store_true", help="Print machine-readable JSON")

    collect = sub.add_parser("collect-context", help="Fetch news/weather context files")
    collect.add_argument("--teams", nargs="*", default=[])
    collect.add_argument("--team-city-map", type=str, default=None)
    collect.add_argument("--out-news", type=str, default="data/news.csv")
    collect.add_argument("--out-weather", type=str, default="data/weather.csv")

    hist_fast = sub.add_parser("fetch-historical-fast", help="Faster ESPN historical fetch (month-batched, no MLB)")
    hist_fast.add_argument("--start", type=str, required=True)
    hist_fast.add_argument("--end",   type=str, default=None)
    hist_fast.add_argument("--leagues", nargs="*", default=None,
                           help=f"ESPN league slugs (default: all). Choices: {list(ESPN_LEAGUES)}")
    hist_fast.add_argument("--out", type=str, default="data/historical_games.csv")
    hist_fast.add_argument("--delay", type=float, default=0.4)

    hist = sub.add_parser("fetch-historical", help="Fetch historical games from ESPN + MLB Stats API")
    hist.add_argument("--start", type=str, required=True, help="Start date YYYY-MM-DD")
    hist.add_argument("--end", type=str, default=None, help="End date YYYY-MM-DD (default: today)")
    hist.add_argument("--leagues", nargs="*", default=None,
                      help=f"ESPN league slugs to include (default: all). Choices: {list(ESPN_LEAGUES)}")
    hist.add_argument("--no-mlb", action="store_true", help="Skip MLB data")
    hist.add_argument("--out", type=str, default="data/historical_games.csv")
    hist.add_argument("--delay", type=float, default=0.5, help="Seconds between API calls (be polite)")

    scoreboard = sub.add_parser("live-scoreboard", help="Fetch today's live/scheduled games across all sports")
    scoreboard.add_argument("--out", type=str, default=None, help="Optional CSV output path")

    standings_cmd = sub.add_parser("fetch-standings", help="Fetch current league standings (ESPN, no key needed)")
    standings_cmd.add_argument("--league", type=str, default="all",
                               help=f"League slug or 'all'. Choices: {list(ESPN_STANDINGS_LEAGUES)}")
    standings_cmd.add_argument("--out", type=str, default="data/standings.csv")

    openliga_cmd = sub.add_parser("fetch-bundesliga", help="Fetch Bundesliga historical match data from OpenLigaDB (free)")
    openliga_cmd.add_argument("--seasons", nargs="*", type=int, default=None,
                              help=f"Season start years e.g. 2022 2023 (default: {BL1_SEASONS})")
    openliga_cmd.add_argument("--out", type=str, default="data/bundesliga_historical.csv")
    openliga_cmd.add_argument("--delay", type=float, default=0.4)

    team_meta_cmd = sub.add_parser("fetch-team-meta", help="Fetch team logos/colours from TheSportsDB (free)")
    team_meta_cmd.add_argument("--teams", nargs="+", required=True, help="Team names to look up")
    team_meta_cmd.add_argument("--out", type=str, default="data/team_meta.csv")

    daily = sub.add_parser("daily-run", help="Fetch data, enrich, train, and backtest")
    daily.add_argument("--games", type=str, required=True)
    daily.add_argument("--sport-key", type=str, required=True)
    daily.add_argument("--odds-snapshots", type=str, default="data/odds_snapshots.csv")
    daily.add_argument("--enriched-out", type=str, default="data/enriched_games.csv")
    daily.add_argument("--artifacts", type=str, default="artifacts")
    daily.add_argument("--teams", nargs="*", default=[])
    daily.add_argument("--team-city-map", type=str, default=None)
    daily.add_argument("--injuries", type=str, default=None)
    daily.add_argument("--news-out", type=str, default="data/news.csv")
    daily.add_argument("--weather-out", type=str, default="data/weather.csv")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "fetch-historical-fast":
        import pandas as _pd
        start = date.fromisoformat(args.start)
        end   = date.fromisoformat(args.end) if args.end else date.today()
        df = fetch_historical_games_fast(
            start_date=start,
            end_date=end,
            leagues=args.leagues,
            delay_seconds=args.delay,
        )
        if df.empty:
            print("no_games_found")
        else:
            os.makedirs(os.path.dirname(args.out) if os.path.dirname(args.out) else ".", exist_ok=True)
            try:
                existing = _pd.read_csv(args.out)
                combined = _pd.concat([existing, df], ignore_index=True)
                combined = combined.drop_duplicates(subset=["date", "home_team", "away_team"])
                combined.to_csv(args.out, index=False)
                print(f"historical_games_written={args.out} total_rows={len(combined)}")
            except FileNotFoundError:
                df.to_csv(args.out, index=False)
                print(f"historical_games_written={args.out} total_rows={len(df)}")
        return

    if args.command == "fetch-historical":
        start = date.fromisoformat(args.start)
        end = date.fromisoformat(args.end) if args.end else date.today()
        df = fetch_historical_games(
            start_date=start,
            end_date=end,
            leagues=args.leagues,
            include_mlb=not args.no_mlb,
            delay_seconds=args.delay,
        )
        if df.empty:
            print("no_games_found")
        else:
            os.makedirs(os.path.dirname(args.out) if os.path.dirname(args.out) else ".", exist_ok=True)
            # Append to existing file if present
            try:
                existing = __import__("pandas").read_csv(args.out)
                combined = __import__("pandas").concat([existing, df], ignore_index=True)
                combined = combined.drop_duplicates(subset=["date", "home_team", "away_team"])
                combined.to_csv(args.out, index=False)
                print(f"historical_games_written={args.out} total_rows={len(combined)}")
            except FileNotFoundError:
                df.to_csv(args.out, index=False)
                print(f"historical_games_written={args.out} total_rows={len(df)}")
        return

    if args.command == "live-scoreboard":
        df = fetch_live_scoreboard()
        if df.empty:
            print("no_games_today")
        else:
            print(df.to_string(index=False))
            if args.out:
                os.makedirs(os.path.dirname(args.out) if os.path.dirname(args.out) else ".", exist_ok=True)
                df.to_csv(args.out, index=False)
                print(f"scoreboard_written={args.out}")
        return

    if args.command == "fetch-standings":
        if args.league == "all":
            df = fetch_all_standings()
        else:
            df = fetch_espn_standings(args.league)
        if df.empty:
            print("no_standings_found")
        else:
            os.makedirs(os.path.dirname(args.out) if os.path.dirname(args.out) else ".", exist_ok=True)
            df.to_csv(args.out, index=False)
            print(f"standings_written={args.out} rows={len(df)}")
        return

    if args.command == "fetch-bundesliga":
        df = fetch_openligadb_historical(seasons=args.seasons, delay=args.delay)
        if df.empty:
            print("no_data_found")
        else:
            os.makedirs(os.path.dirname(args.out) if os.path.dirname(args.out) else ".", exist_ok=True)
            # Append to existing historical_games.csv if it exists
            try:
                import pandas as _pd
                existing = _pd.read_csv("data/historical_games.csv")
                combined = _pd.concat([existing, df], ignore_index=True)
                combined = combined.drop_duplicates(subset=["date", "home_team", "away_team"])
                combined.to_csv("data/historical_games.csv", index=False)
                print(f"appended_to_historical games={len(combined)}")
            except FileNotFoundError:
                pass
            df.to_csv(args.out, index=False)
            print(f"bundesliga_written={args.out} rows={len(df)}")
        return

    if args.command == "fetch-team-meta":
        df = fetch_teams_meta_bulk(args.teams)
        os.makedirs(os.path.dirname(args.out) if os.path.dirname(args.out) else ".", exist_ok=True)
        df.to_csv(args.out, index=False)
        print(f"team_meta_written={args.out} rows={len(df)}")
        return

    if args.command == "generate-sample":
        out = write_sample_data(out_path=args.out, rows=args.rows, seed=args.seed)
        print(f"sample_data_written={out}")
        return

    if args.command == "full-run":
        result = full_run(data_path=args.data, out_dir=args.out)
        print(json.dumps(result, indent=2))
        return

    if args.command == "sport-models":
        result = train_all_sport_models(
            data_path=args.data,
            out_dir=args.out,
            n_splits=args.splits,
        )
        print(json.dumps(result, indent=2, default=str))
        return

    if args.command == "fetch-odds":
        out = save_odds_snapshot(
            sport_key=args.sport_key,
            out_path=args.out,
            region=args.region,
            market=args.market,
            historical_iso_date=args.historical_date,
        )
        print(f"odds_snapshot_written={out}")
        return

    if args.command == "enrich-data":
        out = enrich_games_with_context(
            games_path=args.games,
            out_path=args.out,
            injuries_path=args.injuries,
            news_path=args.news,
            weather_path=args.weather,
            line_snapshots_path=args.line_snapshots,
        )
        print(f"enriched_data_written={out}")
        return

    if args.command == "check-env":
        report = env_report()
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            for key, ok in report.items():
                print(f"{key}={'OK' if ok else 'MISSING'}")
        return

    if args.command == "collect-context":
        if args.teams:
            news_out = fetch_news_for_teams(teams=args.teams, out_path=args.out_news)
            print(f"news_written={news_out}")
        if args.team_city_map:
            wx_out = fetch_weather_for_teams(team_city_map_path=args.team_city_map, out_path=args.out_weather)
            print(f"weather_written={wx_out}")
        if not args.teams and not args.team_city_map:
            print("nothing_to_collect=provide --teams and/or --team-city-map")
        return

    if args.command == "daily-run":
        result = run_daily_pipeline(
            games_path=args.games,
            enriched_out_path=args.enriched_out,
            artifacts_dir=args.artifacts,
            sport_key=args.sport_key,
            odds_snapshots_path=args.odds_snapshots,
            teams=args.teams,
            team_city_map_path=args.team_city_map,
            injuries_path=args.injuries,
            news_out_path=args.news_out,
            weather_out_path=args.weather_out,
        )
        print(json.dumps(result, indent=2))
        return

    parser.error("Unknown command")


if __name__ == "__main__":
    main()
