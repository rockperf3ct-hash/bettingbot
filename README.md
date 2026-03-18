# Sports Prediction System (Realistic + Production-Oriented)

This project is a full starter template for building a sports betting model with realistic expectations and robust ML workflow.

## Reality Check First

- 80% win rate is not realistic in efficient betting markets.
- Professional-level performance is usually around 54% to 56% on standard lines.
- Long-term profit comes from probability calibration, line shopping, and disciplined bankroll management.

## What This Project Includes

- API-first data ingestion and persistence (API-Football, The Odds API, NewsAPI, OpenWeather, Reddit)
- Feature engineering for context-aware sports modeling
- Walk-forward training and validation (no random split leakage)
- Multi-model benchmarking (LogReg, HistGB, optional XGBoost/LightGBM)
- Probability calibration and evaluation (log loss, Brier)
- Betting decision engine with de-vig, edge filter, fractional Kelly sizing, and CLV tracking
- End-to-end pipeline to train, backtest, and export reports

## Project Layout

`sports_model/config.py` - settings and risk controls  
`sports_model/data_sources.py` - API clients and normalized payload helpers  
`sports_model/datasets.py` - dataset builders for odds snapshots and context enrich  
`sports_model/context.py` - point-in-time injury/news/sentiment/weather merge logic  
`sports_model/odds.py` - open/mid/close line derivation and closing odds attach  
`sports_model/automation.py` - daily automation helpers  
`sports_model/env_checks.py` - required key checks  
`sports_model/features.py` - rolling features and context features  
`sports_model/modeling.py` - model benchmarking, walk-forward, final fit  
`sports_model/backtest.py` - edge detection, bet sizing, bankroll simulation  
`sports_model/pipeline.py` - orchestration for full run  
`sports_model/simulate_data.py` - sample dataset generator  
`run.py` - CLI entrypoint

## Install

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Copy `.env.example` to `.env` and fill keys you have.

## Quick Start

1) Generate sample historical data:

```bash
python run.py generate-sample --rows 3000 --out data/historical_games.csv
```

Check env keys:

```bash
python run.py check-env
```

2) Train + walk-forward validate + backtest:

```bash
python run.py full-run --data data/historical_games.csv --out artifacts
```

3) Pull odds snapshots and build open/mid/close lines:

```bash
python run.py fetch-odds --sport-key soccer_epl --out data/odds_snapshots.csv
```

Collect context from APIs:

```bash
python run.py collect-context --teams Arsenal Chelsea Liverpool --team-city-map data/teams_template.csv --out-news data/news.csv --out-weather data/weather.csv
```

4) Enrich games with point-in-time context:

```bash
python run.py enrich-data --games data/historical_games.csv --news data/news.csv --injuries data/injuries.csv --line-snapshots data/odds_snapshots.csv --out data/enriched_games.csv
```

5) Train on enriched dataset:

```bash
python run.py full-run --data data/enriched_games.csv --out artifacts
```

One-command daily flow:

```bash
python run.py daily-run --games data/historical_games.csv --sport-key soccer_epl --odds-snapshots data/odds_snapshots.csv --team-city-map data/teams_template.csv --injuries data/injuries_template.csv --teams Arsenal Chelsea Liverpool
```

Outputs:

- `artifacts/model.joblib`
- `artifacts/metrics.json`
- `artifacts/model_benchmark.json`
- `artifacts/backtest_bets.csv`
- `artifacts/backtest_summary.json`

## Minimum Input Data Schema

Required columns:

- `date` (ISO date)
- `league`
- `home_team`, `away_team`
- `home_score`, `away_score`
- `home_odds`, `away_odds` (decimal odds)

Optional but strongly recommended:

- `home_rest_days`, `away_rest_days`
- `travel_km_diff`
- `is_b2b_home`, `is_b2b_away`
- `injury_impact_home`, `injury_impact_away`
- `sentiment_home`, `sentiment_away`
- `weather_temp_c`, `weather_wind_kph`
- `closing_home_odds`, `closing_away_odds`

For point-in-time supplemental inputs:

- `injuries.csv`: `team`, `as_of`, `impact`
- `news.csv`: `team`, `publishedAt`, `title`, `description`
- `weather.csv`: `home_team`, `as_of`, `weather_temp_c`, `weather_wind_kph`

## Production Guidance

- Prefer APIs over scraping for reliability and legal safety.
- Add injury/news/public sentiment/weather features before increasing model complexity.
- Track CLV and drawdown; ROI alone is not enough.
- Re-train on schedule (daily/weekly) with strict point-in-time feature generation.
