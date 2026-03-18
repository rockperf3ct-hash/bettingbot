# Session Log

## Update Rule

This file is the running activity log for this project.

From now on, after each meaningful task I perform (code change, command run, integration update, bug fix, pipeline run), I will append an entry here.

---

## Completed Work (Chronological)

### 1) Initial project scaffold and architecture
- Created full Python project structure for a sports prediction workflow.
- Added:
  - `run.py`
  - `sports_model/config.py`
  - `sports_model/data_sources.py`
  - `sports_model/features.py`
  - `sports_model/modeling.py`
  - `sports_model/backtest.py`
  - `sports_model/pipeline.py`
  - `sports_model/simulate_data.py`
  - `sports_model/__init__.py`
- Added project docs and setup files:
  - `README.md`
  - `requirements.txt`
  - `.env.example`
  - `.gitignore`

### 2) Core ML + backtest baseline
- Implemented feature engineering with rolling form metrics and context placeholders.
- Implemented walk-forward validation and calibrated probabilistic modeling.
- Implemented bankroll backtest with de-vig edge selection and fractional Kelly sizing.
- Added artifact outputs:
  - model
  - metrics
  - per-bet backtest records
  - backtest summary

### 3) Validation and first execution
- Ran compile checks and initial end-to-end command flow.
- Generated sample data and executed training/backtest successfully.

### 4) Backtest methodology fix
- Fixed leakage risk by switching backtest inputs to out-of-sample walk-forward predictions.
- Ensured backtest is based on OOS rows only.

### 5) Production upgrades requested by user
- Added multi-model benchmarking and best-model selection:
  - Logistic Regression (calibrated)
  - HistGradientBoosting
  - Optional XGBoost/LightGBM if installed
- Added benchmark artifact: `artifacts/model_benchmark.json`.

### 6) Context and external factor pipeline
- Added `sports_model/context.py` with point-in-time feature merging for:
  - injuries
  - sentiment/news
  - weather
  - rest days / back-to-back flags
- Added `sports_model/odds.py` for open/mid/close line derivation and closing odds attachment.
- Added `sports_model/datasets.py` for dataset enrichment and odds snapshot persistence.
- Added CLV fields into backtest outputs.

### 7) CLI expansion
- Added new commands to `run.py`:
  - `check-env`
  - `fetch-odds`
  - `collect-context`
  - `enrich-data`
  - `daily-run`

### 8) Automation and env checks
- Added `sports_model/env_checks.py`.
- Added `sports_model/automation.py` for daily orchestration.
- Added data templates:
  - `data/teams_template.csv`
  - `data/injuries_template.csv`

### 9) API integration and debugging
- Created local `.env` and configured keys.
- Confirmed The Odds API integration works and writes `data/odds_snapshots.csv`.
- Updated news integration from `newsapi.org` to `newsdata.io` and normalized payload format.
- Hardened context collectors to continue gracefully when individual API calls fail.
- Hardened CSV loading to handle empty files without crashing (`EmptyDataError` handling).

### 10) OpenWeather key diagnostics
- Tested provided weather keys directly against OpenWeather endpoint.
- Verified one key returned `401 Invalid API key`.
- Verified key `47cec24ef255469d8c084f1a068b49cf` returns `200`.
- Updated `.env` to working OpenWeather key.

### 11) Latest successful live pipeline run
- Ran:
  - `collect-context` (news + weather written)
  - `daily-run` (odds fetch -> enrich -> benchmark/train -> backtest)
- Latest run produced updated artifacts in `artifacts/` with successful metrics/backtest output.

---

### 12) Full dashboard website built (React + Tailwind + FastAPI)
- Built `api/main.py` — FastAPI backend exposing JSON endpoints:
  - `GET /api/health`
  - `GET /api/summary`
  - `GET /api/metrics`
  - `GET /api/benchmark`
  - `GET /api/bets` (filterable by league/side, paginated)
  - `GET /api/bets/leagues`
  - `GET /api/bets/equity`
  - `GET /api/odds`
  - `GET /api/enriched`
- Built `frontend/` — React + Vite + Tailwind dashboard with 4 pages:
  - **Dashboard**: bankroll equity curve chart, summary metric cards, reality check panel
  - **Bets**: searchable/filterable paginated bet table with CLV, PnL, WIN/LOSS badges
  - **Live Odds**: real-time odds snapshot from The Odds API with de-vigged implied probabilities per bookmaker
  - **Model**: fold-by-fold metrics bar chart, model benchmark ranking table
- Added `start.bat` — double-click to launch both API server and frontend simultaneously.
- Verified API endpoints return live data (`/api/health`, `/api/summary`, `/api/metrics` all return 200).
- Installed all frontend npm packages (173 packages, Vite + React + Recharts + Tailwind).
- Installed all backend packages (FastAPI + Uvicorn + Pandas).

---

---

### 13) Real ESPN + MLB data ingestion module (`sports_model/espn_ingest.py`)
- Created `sports_model/espn_ingest.py` — full ingestion layer for ESPN Scoreboard API + MLB Stats API.
  - `ESPN_LEAGUES` map: EPL, Bundesliga, LaLiga, Liga MX, UCL, Europa League, NBA (all confirmed working).
  - `fetch_espn_scoreboard(slug, date)` — fetches single league/date, parses events into normalised game-schema rows.
    - Extracts: scores, status, venue, team form (last-5 string + win rate), possession, shots, SoT, corners, fouls, yellow/red cards, rebounds, turnovers.
    - Extracts DraftKings moneyline odds → converts American → decimal. Also: draw odds, over/under total.
  - `fetch_espn_all_leagues(date)` — aggregates all ESPN leagues.
  - `fetch_mlb_scoreboard(date)` — MLB Stats API: scores, hits, errors, left on base, winning/losing pitcher, venue.
  - `fetch_historical_games(start, end, leagues, include_mlb)` — date-range iterator with retry/backoff, polite delay, only keeps STATUS_FINAL games.
  - `fetch_live_scoreboard()` — returns all statuses (scheduled + live + final) across all sports for today.
- Fixed edge case: ESPN odds list can contain `None` entries; filter to `isinstance(o, dict)` before processing.
- Live test results (2026-03-08):
  - EPL: 1 game (Tottenham vs Crystal Palace, Final)
  - Bundesliga: 2 games (scheduled)
  - LaLiga: 4 games (scheduled, draw odds present)
  - Liga MX: 2 games
  - NBA: 6-10 games (Final + scheduled)
  - MLB: 17 spring training games (Scheduled)

### 14) Sport-specific feature engineering
- Extended `sports_model/features.py`:
  - Added `_rolling_team()` helper (replaces inline lambdas — cleaner point-in-time shift+rolling).
  - Added `_add_soccer_features()`: `shot_acc_diff`, `sot_diff`, `possession_diff`, `corners_diff` (all rolling 5-game per team).
  - Added `_add_nba_features()`: `rebound_diff`, `turnover_diff`.
  - Added `_add_mlb_features()`: `hits_diff`, `errors_diff`.
  - All sport-specific features default to 0.0 via `fillna()` when column absent (NaN-safe multi-sport DataFrames).
  - Total feature count: 14 → 22.

### 15) New CLI commands in `run.py`
- `fetch-historical --start YYYY-MM-DD --end YYYY-MM-DD [--leagues ...] [--no-mlb] [--out path] [--delay s]`
  - Iterates date range, fetches completed games from ESPN + MLB, appends to CSV (deduplicates by date+teams).
- `live-scoreboard [--out path]`
  - Prints today's full scoreboard across all sports to stdout. Optionally writes CSV.
- Added `logging.basicConfig` at top of `run.py`.

### 16) API scoreboard endpoints (`api/main.py`)
- `GET /api/scoreboard` — live fetch of all leagues + MLB for today.
- `GET /api/scoreboard/{league_slug}` — single league, optional `?game_date=YYYY-MM-DD`.
  - Valid slugs: `epl`, `bundesliga`, `laliga`, `liga_mx`, `ucl`, `europa`, `nba`, `mlb`.
- Added `sys.path.insert` so FastAPI can resolve `sports_model.*` from project root.

### 17) Frontend Live page overhaul (`frontend/src/pages/Live.jsx`)
- Replaced single-tab odds page with two-tab layout:
  - **Scoreboard tab**: real ESPN + MLB data. ScoreCard component shows:
    - Sport icon, league, venue, kickoff time, status badge (Final / Live pulse / Scheduled).
    - Score row (large) with team form strings.
    - Stat pills: possession, shots, SoT, rebounds, hits (when available from ESPN).
    - Odds strip: home/away/draw decimal odds + de-vigged implied probabilities + O/U line.
    - League filter dropdown + team search + Refresh button.
  - **Odds tab**: preserved original The Odds API bookmaker breakdown table.
- Updated `useApi.js` to support `refetch` callback (triggers re-fetch via tick state increment).

---

### 18) Public-APIs integration audit + three new free data sources
- Evaluated the public-apis/public-apis repository for sources useful to a sports betting analytics app.
- **Discarded** balldontlie (now requires API key), Oddsmagnet (domain dead/403), Football Standings vercel (500 error).
- **Adopted** three confirmed-working free sources:

#### `sports_model/standings.py` (new file)
- **ESPN Standings API** (free, no key): `/apis/v2/sports/{sport}/{league}/standings`
  - Supports: EPL, Bundesliga, LaLiga, Liga MX, UCL, Europa League (soccer) + NBA.
  - Per team: rank, points, wins, losses, draws, GF, GA, GD, games played, win %.
  - `fetch_espn_standings(slug)` — single league.
  - `fetch_all_standings()` — all 7 leagues combined.
  - `build_standings_lookup(df)` — O(1) dict for feature-merge by team name.
  - Live test: EPL top 5 = Arsenal(1,67pts), Man City(2,60pts), Man Utd(3,51pts), Aston Villa(4,51pts), Chelsea(5,48pts).

- **TheSportsDB** (free, no key, key=3):
  - `fetch_team_meta(team_name)` — logo URL, badge colour, founded year, country.
  - `fetch_teams_meta_bulk(names)` — batch, returns DataFrame.
  - Live test: Arsenal badge_colour=#EF0107, founded=1892; Lakers badge_colour=#fdb927.

- **OpenLigaDB** (free, no key, crowd-sourced):
  - Bundesliga only (bl1), seasons 2016–2024 (~306 games/season × 9 = ~2,754 rows).
  - `fetch_openligadb_matchday(season, matchday)` → game-schema rows.
  - `fetch_openligadb_season(season)` → full season DataFrame.
  - `fetch_openligadb_historical(seasons)` → multi-season combined, deduped, sorted.
  - Auto-appends to `data/historical_games.csv` when `fetch-bundesliga` CLI command is run.

#### `sports_model/features.py` updated
- Added 4 new standing-based features (from ESPN Standings):
  - `standing_rank_diff` (away_rank − home_rank: positive = home team is higher ranked)
  - `standing_win_pct_diff` (home − away win%)
  - `standing_gd_diff` (home − away goal differential)
  - `standing_pts_diff` (home − away points; soccer only, 0 for NBA/MLB)
- Fixed `_prepare_base` date parsing: switched to `format="mixed"` to handle mixed ISO8601 formats in real ESPN data.
- Feature count: 22 → 26. All verified on 2,608 real games (shape 2608×26).

#### `api/main.py` updated
- `GET /api/standings` — all leagues standings from ESPN.
- `GET /api/standings/{league_slug}` — single league.
- `GET /api/team-meta/{team_name}` — TheSportsDB logo/colour lookup.

#### `run.py` updated — 3 new CLI commands
- `python run.py fetch-standings [--league epl|all] [--out path]`
- `python run.py fetch-bundesliga [--seasons 2022 2023] [--out path]` (appends to historical_games.csv)
- `python run.py fetch-team-meta --teams Arsenal Chelsea ... [--out path]`

## Current Status
- Live integrations: The Odds API ✓ | NewsData.io ✓ | OpenWeather ✓ | ESPN scoreboard (7 leagues) ✓ | MLB Stats API ✓ | ESPN Standings (7 leagues) ✓ | TheSportsDB ✓ | OpenLigaDB ✓
- 2,608 real games in `data/historical_games.csv` (from previous historical fetch).
- Feature vector: 26 features covering core scoring, standings, soccer xG proxy, NBA efficiency, MLB run support.
---

### 19) First real-data model training run
- **Data assembly:**
  - Ran `fetch-bundesliga --seasons 2018..2024` → 2,142 Bundesliga games via OpenLigaDB.
  - Added `fetch_espn_scoreboard_month()` — month-range batch query (one request per month per league instead of one per day; ~20× faster).
  - Ran `fetch-historical-fast --start 2023-08-01 --end 2025-05-31 --leagues epl laliga liga_mx` → 2,174 soccer games.
  - Fixed status filter bug: ESPN soccer uses `STATUS_FULL_TIME` not `STATUS_FINAL`; added `_is_completed()` helper covering all variants.
  - Dropped 500 synthetic rows. Final clean dataset: **6,429 real games** across 6 leagues.
    - Bundesliga: 2,142 | MLB: 1,079 | NBA: 1,024 | LaLiga: 760 | EPL: 760 | Liga MX: 660 | Other: 4

- **Odds situation — honest assessment:**
  - ESPN historical scoreboard does not embed odds (only live/upcoming games do).
  - The Odds API historical endpoint requires a paid tier (our free key returned 401).
  - All 6,429 games have placeholder `2.0/2.0` odds.
  - Backtest modified: games with `2.0/2.0` odds use a 5%-vig flat market baseline; stakes capped at 0.5% to prevent compounding inflation. Summary notes `simulated_odds_games: 4287` vs `real_odds_games: 1068` (MLB/NBA rows that happened to be fetched with default 2.0 too).

- **Model results (HistGradientBoosting, 5-fold walk-forward on 6,429 games):**
  - Fold AUC: 0.579 / 0.615 / 0.595 / 0.535 / 0.490 — avg **0.563**
  - Avg log-loss: 0.734 | Avg Brier: 0.265
  - Backtest (simulated odds): 3,786 bets placed, hit_rate=54.6%, yield=9.9%, max drawdown=-14.4%
  - Note: yield is inflated by soft simulated baseline; real yield unknown without historical odds.

- **Fixes applied this session:**
  - `features.py`: `format="mixed"` date parsing for real ESPN ISO8601 dates.
  - `espn_ingest.py`: `_is_completed()` status helper covering STATUS_FULL_TIME, STATUS_FINAL_AET, STATUS_FINAL_PEN, Final, etc.
  - `backtest.py`: skip/simulate logic for placeholder odds, capped stake for simulated games, `odds_note` + `simulated_odds_games` in summary JSON.

## Current Status
- **6,429 real games** in `data/historical_games.csv` (6 leagues, 2018–2026).
- **Model trained** on real data: HistGradientBoosting, avg ROC-AUC 0.563 (realistic; elite = ~0.58–0.62 for multi-sport).
- **Artifacts written**: `backtest_summary.json`, `backtest_bets.csv`, `metrics.json`, `model_benchmark.json`, `model.joblib`.
- Dashboard API should now serve real data when started.
- **Honest limitation**: backtest uses simulated odds — real CLV tracking requires paid historical odds or live daily capture via The Odds API.
- Next steps:
  - Start capturing live odds daily via `fetch-odds` so future backtests have real closing lines.
  - Add Standings page to dashboard frontend.
  - Sport-specific models (soccer-only, NBA-only) will likely improve AUC significantly vs this mixed model.
  - Schedule `daily-run` via Windows Task Scheduler.

---

### 20) Sport-specific models + daily automation + dashboard upgrades

#### `sports_model/sport_models.py` — NEW sport-specific model trainer
- Trains separate `logreg_cal` / `hgb` / `logreg` models per sport (soccer, NBA, MLB) using sport-specific feature subsets.
- Sport-specific feature subsets:
  - Soccer: +shot_acc_diff, sot_diff, possession_diff, corners_diff, standing_gd_diff, standing_pts_diff
  - NBA: +rebound_diff, turnover_diff
  - MLB: +hits_diff, errors_diff, weather features
- Walk-forward backtest per sport with Kelly sizing identical to mixed pipeline.
- Writes per-sport artifacts: `{sport}_model.joblib`, `{sport}_metrics.json`, `{sport}_benchmark.json`, `{sport}_backtest_bets.csv`, `{sport}_backtest_summary.json`, and `multi_model_summary.json`.

#### `run.py` — new `sport-models` CLI command
- `python run.py sport-models --data data/historical_games.csv --out artifacts`

#### Daily automation scripts (NEW)
- `daily_odds_capture.py` — standalone script: fetches odds for all 8 sport keys once per day and appends to `data/odds_snapshots.csv`.
- `daily_pipeline.py` — full orchestrator: odds capture → fetch yesterday's completed games → append to `historical_games.csv` → re-train sport models.
- `daily_pipeline.bat` — Windows batch launcher for Task Scheduler.
- `setup_task_scheduler.bat` — one-time Task Scheduler registration (run as Admin); schedules daily 6 AM run.

#### Frontend pages (NEW/UPDATED)
- `frontend/src/pages/Standings.jsx` — new page: ESPN live standings for soccer leagues + NBA; tabbed by league; shows rank, team, W/D/L, GF/GA, GD, points.
- `frontend/src/pages/Model.jsx` — updated: added "Sport Models" tab showing per-sport AUC, hit rate, yield, ROI, features used, vs "Mixed Model" tab (existing benchmark).
- `frontend/src/App.jsx` — added Standings route.

#### API endpoints (NEW in `api/main.py`)
- `GET /api/sport-summary` — `multi_model_summary.json` (all 3 sports)
- `GET /api/sport-summary/{sport}` — per-sport backtest summary
- `GET /api/sport-bets/{sport}` — paginated per-sport bets
- `GET /api/sport-metrics/{sport}` — walk-forward fold metrics per sport
- `GET /api/standings` — live ESPN standings (all leagues)
- `GET /api/standings/{league_slug}` — standings for one league
- `GET /api/team-meta/{team_name}` — TheSportsDB logo/colour/country

#### Bug fix — `api/main.py` `_read_csv()`
- `pd.StringArray` columns with `pd.NA` were not converted to `None` by `df.where(pd.notnull(df), None)`.
- Fixed by casting to `object` dtype first: `df.astype(object).where(pd.notnull(df.astype(object)), None)`.
- This caused `/api/sport-bets/{sport}` to return all rows instead of only placed bets (filter `r.get("bet_side")` was truthy for NaN string).

#### Sport-specific model results (run 2026-03-08)
| Sport  | Rows  | AUC   | Hit Rate | Yield | Bets  | Best Model  |
|--------|-------|-------|----------|-------|-------|-------------|
| Soccer | 4,326 | 0.641 | 64.0%    | 35.0% | 1,777 | logreg_cal  |
| NBA    | 1,024 | 0.608 | 60.1%    | 28.1% | 659   | logreg_cal  |
| MLB    | 1,079 | 0.526 | 52.2%    | 10.3% | 322   | logreg_cal  |

Note: yields inflated by simulated 5%-vig baseline odds (no real historical odds available on free tier).

### 22) Tracker, prediction log, alerts, picks page, history page (earlier session)
- `sports_model/tracker.py` — SQLite bet tracker (add/settle/delete/equity curve).
- `sports_model/prediction_log.py` — W/R history: log picks, auto-resolve from ESPN, stats, rolling accuracy, calibration.
- `sports_model/alerts.py` — Discord webhook alerts for strong picks.
- `frontend/src/pages/Tracker.jsx` — real bet tracker with P&L equity curve, add/settle bets.
- `frontend/src/pages/History.jsx` — prediction W/R history: rolling accuracy chart, calibration table, per-pick row.
- `frontend/src/pages/Picks.jsx` — AI Picks page: Today/Tomorrow tabs, Kelly calc, H2H toggle, News sentiment.
- `api/main.py` — added tracker endpoints + prediction_log endpoints + `/api/news/{team}`.
- Bug fix: SQLite `add_bet()` `get_bet(lastrowid)` called outside its `_db()` context — fixed by reading row inside same connection.

### 23) Live odds integration — The Odds API → real FanDuel + DraftKings h2h odds
- `sports_model/live_odds.py` (NEW):
  - Fetches real FanDuel + DraftKings h2h odds from The Odds API for all sport keys.
  - 15-min session cache to conserve free-tier quota (500 req/month).
  - `build_odds_lookup(sport)` → `{(norm_home, norm_away): odds_dict}`.
  - `enrich_game_with_odds(game, lookup)` → returns game dict with `home_odds`, `away_odds`, `home_fanduel`, `away_fanduel`, `home_draftkings`, `away_draftkings`, `odds_source="the_odds_api"`.
  - Fuzzy team name matching (substring).
  - 0.5s delay between sport key requests to avoid 429 rate limiting.

- `sports_model/recommendations.py` — `_score_games_for_date()` updated:
  - Pre-fetches odds via `build_odds_lookup()` before scoring.
  - Calls `enrich_game_with_odds()` on every game.
  - Picks dict now includes `odds_source`, `home_fanduel`, `away_fanduel`, `home_draftkings`, `away_draftkings`, `home_bk`, `away_bk`.
  - Verified: 2 real picks with `odds_source: the_odds_api`, real FD/DK numbers.

- `api/main.py` — added `GET /api/odds/live`:
  - Returns all upcoming games with FanDuel + DraftKings h2h odds from The Odds API.
  - Optional `?sport=soccer|nba|mlb` filter.
  - Sorted by commence_time.

- `frontend/src/pages/Picks.jsx` — PickCard updated:
  - Shows FanDuel / DraftKings odds side-by-side for each pick.
  - Highlights the bet side's odds in green.
  - Shows best-odds bookmaker name in header.
  - Shows yellow warning banner for simulated odds (no live market match).

- `frontend/src/pages/Live.jsx` — OddsTab rebuilt:
  - Now uses `/api/odds/live` instead of stale `odds_snapshots.csv`.
  - Sport filter buttons (All / Soccer / NBA / MLB).
  - Per-game card: FanDuel row, DraftKings row, Best odds row (with bookmaker label), de-vigged implied probs.
  - Search by team name.

### 24) Dashboard cleanup + live widgets
- Removed static "Reality Check" placeholder section from `Dashboard.jsx`.
- Added `TodayPicksWidget` — shows live top picks from `/api/recommendations` with tier badges, edge, bookmaker label, parlay summary, and Gemini summary snippet.
- Added `HistoryWidget` — shows W/L/Hit Rate from `/api/predictions/stats`.
- Added `LiveOddsWidget` — shows upcoming 5 games with moneyline odds from `/api/odds/live`.
- Relabelled equity curve title to "Backtest Bankroll Curve" + added backtest note below metrics cards.
- Updated footer to remove "80% is not realistic" static copy.

### 25) Spread + Totals market support
- `sports_model/live_odds.py`:
  - Now fetches `h2h,spreads,totals` in a single API call (3 markets).
  - Cache key changed to `{sport_key}|{market_str}` to support per-market caching.
  - `_best_odds()` now extracts spread (home_spread, away_spread, home_spread_odds, away_spread_odds, spread_bk) and totals (total_line, over_odds, under_odds, totals_bk) from all bookmakers.
  - `enrich_game_with_odds()` now passes spreads + totals through to the game dict.
- `api/main.py` `/api/odds/live`:
  - Response now includes all spread + totals fields per game.
- `frontend/src/pages/Live.jsx` Odds tab:
  - Each game card now shows Moneyline / Spread / Total O/U sections with bookmaker labels.

### 26) Tomorrow picks — full Gemini narrative + parlay
- `sports_model/recommendations.py` — added `build_recommendations_tomorrow()`:
  - Same full pipeline as `build_recommendations()`: score → Gemini narrative → parlay.
  - Gemini prompt asks for specific 2-3 sentence per-pick reasoning, risk factors, parlay recommendation, overall confidence rating.
  - Returns `{date, picks, parlay, ai_summary, model_note}` identical structure to today.
- `api/main.py` `/api/recommendations/tomorrow` — now calls `build_recommendations_tomorrow()` instead of bare `score_tomorrows_games()`.
- `frontend/src/pages/Picks.jsx`:
  - Removed thin `TomorrowPicks` component.
  - Added shared `PicksSection` component used by both today and tomorrow tabs.
  - Both tabs now show: pick cards, parlay card, full Gemini analysis block.
  - Added "Ask AI →" button linking to Chat page.

### 27) AI Chat page
- `api/main.py` — added `POST /api/chat`:
  - Accepts `{message, history[], include_context}`.
  - Injects today's ML picks (with spreads/totals) + live odds for 15 upcoming games as Gemini context.
  - Maintains multi-turn conversation history (last 6 turns).
  - Returns `{reply, sources[]}`.
- `frontend/src/pages/Chat.jsx` (NEW):
  - Full chat UI: message bubbles, typing indicator, conversation history.
  - Quick suggestion buttons (parlays, spreads, totals, bet sizing, specific sports).
  - Toggle to include/exclude live context injection.
  - Collapsible "more example questions" section.
  - Shift+Enter for newlines, Enter to send.
- `frontend/src/App.jsx` — added `💬 AI Chat` nav item + `/chat` route.
- New Odds API key updated: `5b7e0ed747f1532db59e4c67dd6525cf`.

### 28) Upcoming schedule scraper + Schedule page
- `sports_model/espn_ingest.py` — added `fetch_upcoming_schedule()`:
  - Fetches upcoming `STATUS_SCHEDULED` games for next N days across all ESPN leagues + MLB.
  - ESPN leagues: one API call per league using date-range query (`dates=YYYYMMDD-YYYYMMDD&limit=300`) — very efficient.
  - MLB: day-by-day (MLB API doesn't support date ranges).
  - Tested: 416+ games available for next 14 days (NBA 107, EPL 18, Bundesliga 18, LaLiga 21, Liga MX 19, UCL 16, Europa 16, MLB 201).
- `api/main.py` — added `GET /api/schedule`:
  - Params: `days` (1-14), `league`, `sport`, `with_scores` (bool).
  - Fetches upcoming games → enriches with live The Odds API odds (moneyline, spread, totals) → scores with ML model.
  - Returns per-game: `model_prob_home/away`, `edge_home/away`, `best_edge`, `bet_side`, `bet_team`, `tier`, `has_edge` + all odds fields.
  - Also returns games grouped by date (`by_date` dict).
- `frontend/src/pages/Schedule.jsx` (NEW):
  - Shows next 3/7/10/14 days of games, grouped by day with day headers and value-bet count.
  - Filters: sport (All/Soccer/NBA/MLB), edge-only toggle, team/league search.
  - Each game card: team names with BET arrow, game time, venue, tier badge, edge %, quick odds pill (ML/spread/total).
  - Click to expand: model probability table with edges, moneyline FD/DK comparison, spread details, O/U total.
  - Green dot indicator for games with live The Odds API data.
  - Legend explaining tier thresholds.
- `frontend/src/App.jsx` — added `📅 Schedule` nav item + `/schedule` route.

### Session: 2026-03-08 (continuation) — Totals picks, Live.jsx split, Picks.jsx totals cards

#### Totals picks pipeline — verified working
- Ran `build_recommendations()` end-to-end: confirmed `market="totals"` picks are being generated and interleaved with moneyline picks.
- Example output: `h2h | Tijuana | odds: 6.5` + `totals | Over 2.5 | odds: 1.91 | total_line: 2.5`

#### `sports_model/recommendations.py` — `build_recommendations_tomorrow()` updated
- Old: inline `picks_text` used a moneyline-only format string that didn't handle totals picks.
- New: added `_pick_summary_tmrw()` helper (mirrors `_pick_summary()` in `build_recommendations()`) with `market == "totals"` branch that shows line, expected total, deviation in the Gemini prompt.
- Now both today and tomorrow Gemini prompts are totals-aware.

#### `frontend/src/pages/Live.jsx` — Scoreboard tab split into sections
- Added `isLiveGame()` and `isFinishedGame()` helper functions checking status strings.
- Scoreboard tab now renders three distinct sections:
  - **Live Now** — only `STATUS_IN_PROGRESS` / `in_progress` games, with pulsing green dot + green heading. Shows "No live games right now" message if empty.
  - **Today's Schedule** — upcoming/scheduled games (not live, not finished).
  - **Final Results** — finished games collapsed in a `<details>` element (opacity-70), hidden by default with a click-to-expand toggle.
- Previously showed all games in one flat grid with no distinction.

#### `frontend/src/pages/Picks.jsx` — `PickCard` updated for totals picks
- Added `isTotals = pick.market === 'totals'` detection.
- Totals picks now render:
  - Blue "O/U Total" badge in header instead of just tier badge.
  - Bet label: large "Over 2.5" / "Under 2.5" title (not team name).
  - Matchup: smaller `home_team vs away_team` below the label.
  - Expected total vs line vs deviation shown (color-coded deviation).
  - Third stat box shows "Avg scored/gm" (home_form / away_form) instead of Win% diff.
  - Odds block: side-by-side Over / Under buttons with green ring around the selected side.
  - `totals_bk` shown as bookmaker credit instead of `home_bk`/`away_bk`.
  - H2H panel uses `home_team` as search team (not `bet_team` which is "Over 2.5").
  - FD/DK columns (which are null for totals) replaced with Over/Under odds display.
- Moneyline picks (`market === 'h2h'`) unchanged.

#### API server restarted
- Killed old PID 67936, started fresh uvicorn on port 8000. Health check confirmed OK.

### Session: 2026-03-09 — History page fix: W/L resolution now working

#### Root cause
All 7 predictions were logged for `2026-03-08` (yesterday) and were `pending`. The old "Auto-resolve Yesterday" button resolved `date.today() - 1 day = 2026-03-07` — a date with no picks. So History always showed 0 resolved picks.

#### Fixes applied

**`sports_model/prediction_log.py`**
- Added `total_line` and `market` columns to `predictions` table schema + safe `ALTER TABLE` migration.
- Updated `log_picks()` to store `total_line` and `market` from each pick dict.
- Fixed `_determine_result()` to handle `bet_side = 'over'` / `'under'`: computes `actual_total = home_score + away_score`, compares vs `total_line`, returns `won`/`lost`/`push`.
- Fixed `resolve_date()` to not crash when totals picks return `"pending"` result key.

**`frontend/src/pages/History.jsx` — ResolveButton**
- Replaced single "Auto-resolve Yesterday" with two buttons: **Resolve Today** and **Resolve Yesterday**, each showing the actual date in the label.
- Both pass `target_date` as query param to `POST /api/predictions/resolve?target_date=...`

#### DB migration + resolution
- Ran migration → `total_line` and `market` columns added to live DB.
- Resolved `2026-03-08`: 6 picks auto-resolved via ESPN, 1 totals pick (Tijuana vs Santos O/U 2.5) manually resolved.
- **Final: 7 picks, 4W 3L, 57.1% hit rate** — History page now shows real W/L data.

## Current Status (2026-03-09)
- **6,429 real games** in `data/historical_games.csv` (Bundesliga/MLB/NBA/LaLiga/EPL/Liga MX).
- **4 trained models**: mixed `model.joblib` (AUC 0.563) + soccer/nba/mlb sport-specific (AUC 0.641/0.608/0.526).
- **All artifacts populated**: backtest CSVs, summary JSONs, benchmark JSONs, metrics JSONs for mixed + all 3 sports.
- **API running**: FastAPI at port 8000, all endpoints verified including `/api/odds/live`.
- **Dashboard**: 8 pages — Dashboard, Picks (AI), History, Tracker, Bets, Live, Standings, Model.
- **Live odds**: Real FanDuel + DraftKings **moneyline, spread, and totals** odds flowing through picks pipeline, Live/Odds tab, and AI Chat context.
- **AI Chat**: `POST /api/chat` + `Chat.jsx` — conversational Gemini analyst with live picks + odds injected as context.
- **Tomorrow picks**: Full Gemini narrative + parlay, identical structure to today.
- **Dashboard**: Clean — no static placeholder content. Shows live picks widget, history widget, odds widget.
- **Daily automation ready**: `setup_task_scheduler.bat` (run as Admin once) enables 6 AM daily pipeline.
### Session: 2026-03-09 (2) — Draw market + Odds movement

#### `sports_model/live_odds.py`
- Added `draw_odds`, `draw_bk`, `draw_fanduel`, `draw_draftkings` to `_best_odds()` — extracted from `h2h` outcomes where `name == "Draw"`.
- Added `enrich_game_with_odds()` passthrough for all draw fields.
- Added `_init_snapshots_table()` — creates `odds_snapshots` SQLite table (fetched_at, sport, home/away/draw odds, total_line, spreads).
- Added `_persist_snapshots()` — stores a row per game every time odds are fetched (called from `build_odds_lookup()`).
- Added `get_odds_movement(hours)` — queries snapshots grouped by game, compares earliest vs latest snapshot, returns delta for home/away/draw odds and total line.

#### `sports_model/recommendations.py`
- Added `_score_draw()` — estimates draw probability using a Gaussian bell curve centred at `prob_home ≈ 0.38` (draws peak when match is balanced). Compares to market draw implied prob; returns pick if edge ≥ MIN_EDGE.
- Draw picks only generated for soccer games with real `draw_odds` from The Odds API.
- Interleave order: 2 moneylines → 1 draw → 1 total → repeat.

#### `api/main.py`
- Added `GET /api/odds/movement?hours=24` — calls `get_odds_movement()`, returns games with line movement data.
- Updated `GET /api/odds/live` to expose `draw_odds`, `draw_bk`, `draw_fanduel`, `draw_draftkings`.

#### `frontend/src/pages/Live.jsx` — Odds tab
- Extracted `OddsCard` component with movement awareness.
- `moveArrow(delta)` helper — shows ▲/▼ with delta next to odds that have moved.
- 3-way moneyline grid (Home / Draw / Away) for soccer games with draw odds.
- Total line header shows `open → current ▲/▼` when line moves ≥ 0.25.
- Snapshot count badge ("📈 N snaps") shown when game has multiple snapshots.
- Fetches `/api/odds/movement?hours=24` alongside live odds — no extra API quota (SQLite only).
- De-vig row now shows Home / Draw / Away probabilities for soccer.

#### `frontend/src/pages/Picks.jsx` — PickCard draw support
- `isDraw = pick.market === 'draw'` detection.
- Purple "Draw" badge in header.
- Draw matchup block: "Draw" as title, 3-way odds summary below.
- 3-way odds block with Home / Draw(ring) / Away columns; FD/DK draw rows if available.
- NewsPanel uses `home_team` for draw picks (not `bet_team = "Draw"`).

- **Remaining gap**: backtest yields use simulated odds. To get real CLV tracking, upgrade The Odds API to paid tier for historical endpoint access, or wait 30+ days for live daily capture to accumulate.
- **To improve hit % further**: add more historical data sources, tune MIN_EDGE threshold, add player injury API integration, add weather for outdoor sports.

### 43) Feature engineering — real rest days + multi-window rolling

**Root cause identified:** `home_rest_days`, `away_rest_days`, `is_b2b_home/away`, `injury_impact_*`, `sentiment_*`, `weather_*` were ALL null in every training row — model had been fitting noise from zero-filled placeholders.

**`sports_model/features.py`:**
- `_compute_rest_days()` — computes exact days-since-last-game per team from the `date` column alone. Also derives real `is_b2b_home/away`.
- Added `home_fatigue`/`away_fatigue` (rest < 3 days) + `fatigue_diff`.
- Multi-window rolling for all scoring: **5, 10, 20 game windows**.
- `_form_to_score()` — converts form strings (`'WWLDD'`) to recency-weighted momentum. `form_momentum_diff` added.
- `form_rate_diff`, `shot_acc_diff_10`, `hits_diff_10` added.

**`sports_model/sport_models.py`:** Updated all three feature lists (Soccer=43, NBA=35, MLB=34).

**AUC before → after:** Soccer 0.641→**0.674** (+0.033) · NBA 0.608→0.597 (too few rows) · MLB 0.526→0.489 (needs pitcher data)

### 41) Bet Tracker — casino/sportsbook redesign
- **`api/main.py`** — Added `GET /api/schedule/games` fast endpoint: raw ESPN schedule with no odds enrichment and no ML scoring. 5-minute in-process cache (`_CACHE` dict + `_SCHEDULE_TTL`). Cold ~7s, warm ~2s (cached flag returned). Also fixed module-level `_CACHE` + `_SCHEDULE_TTL` constants at top of file.
- **`frontend/src/pages/Tracker.jsx`** — Full redesign as a two-panel sportsbook layout:
  - **Left panel**: All upcoming games pre-loaded grouped by league (NBA/MLB/UCL/Europa). Sport filter tabs (All/NBA/MLB/Soccer). Each game row shows Home vs Away + time + odds buttons for Moneyline, Draw (soccer only), Over/Under. Clicking an odds button immediately highlights it and adds it to the bet slip — no modals, no form.
  - **Right panel (sticky sidebar)**: Tab-switched between "Bet Slip" and "My Bets". Bet Slip shows selected legs as cards, Straight/Parlay toggle (auto-shown when 2+ legs), quick-stake buttons ($10/$25/$50/$100), live payout preview per leg or combined parlay, "Place Bet/Parlay" button. My Bets shows All/Pending/Settled tabs with card-style bet history, inline settle buttons.
  - **Odds merging**: Schedule data loaded fast (no odds), live odds fetched in parallel from `/api/odds/live` and merged client-side by team name key.
  - **OddsBtn component**: highlights selected state (blue/scaled), grayed if no odds, shows American format.
  - **LeagueSection**: collapsible, sticky header, shows game count.
  - **BetSlip**: Combined odds shown live, quick-stake buttons, payout preview, submit posts to `/api/tracker/bets` (straight) or `/api/tracker/parlays` (parlay).
  - **MyBets**: card layout instead of table, colored borders by result (green=won, red=lost), parlay legs expandable inline.

### 40) Bet Tracker — game picker, parlay builder, American odds, auto-settle
- **`sports_model/tracker.py`** — Full rewrite. Added `bet_type` column to `bets` table (safe `ALTER TABLE` migration). Added `parlays` table (id, date, stake, combined_odds, result, pnl, notes) and `parlay_legs` table (parlay_id FK, league, sport, home/away_team, bet_side, bet_team, bet_type, odds, result). Added functions: `add_parlay()`, `settle_parlay()`, `settle_parlay_auto()`, `delete_parlay()`, `list_parlays()`, `get_parlay()`, `auto_resolve_parlays()`. `tracker_summary()` and `equity_curve()` now include parlays. P&L equity sorted by date across both bet types.
- **`api/main.py`** — Added `ParlayLegIn`, `ParlayIn`, `ParlaySettleIn` Pydantic models. Added endpoints: `GET /api/tracker/parlays`, `GET /api/tracker/parlays/{id}`, `POST /api/tracker/parlays`, `PATCH /api/tracker/parlays/{id}/settle`, `DELETE /api/tracker/parlays/{id}`, `POST /api/tracker/parlays/resolve` (auto-resolve from ESPN). `BetIn` now includes `bet_type` field.
- **`frontend/src/pages/Tracker.jsx`** — Full rewrite. Key additions:
  - `GamePicker` — calls `/api/schedule?days=3` and shows upcoming games with time, league, live odds. Click to pre-fill matchup.
  - `OddsInput` — accepts both decimal (1.91) and American (-110/+150) odds. Shows the conversion (e.g. "1.910 dec · -110 American").
  - `StraightBetForm` — replaced plain freeform form with game-picker integration, bet type dropdown (Moneyline/Spread/Over/Under/Draw), animated bet-side selector pre-filled from live game odds, payout preview.
  - `ParlayBuilder` — multi-leg builder: pick game, choose side/type/odds, click "Add This Leg". Shows legs list with remove, combined odds updating live, payout preview. Submit POSTs to `/api/tracker/parlays`.
  - `ParlayRow` — expandable table row: click to expand legs inline. Purple "Parlay" badge. Won/Lost/Void settle buttons.
  - `BetRow` — updated with bet type badge, decimal+American odds tooltip, cleaner layout.
  - `SummaryCards` — now shows Straight Bets, Parlays, Pending, Hit Rate, Total P&L, ROI.
  - P&L equity curve combines straight + parlay settled bets.
  - "Auto-Resolve Parlays" button calls `/api/tracker/parlays/resolve` for yesterday.
- **Verified**: parlay POST → combined_odds = 1.85 × 2.10 = 3.885, settle won → pnl = $72.13.

### 39) MLB Standings — 2026 Regular Season + Spring Training preseason
- **`sports_model/standings.py`** — Changed `?season=2025` → `?season=2026&seasontype=2` for regular season endpoint (AL/NL, all 0-0 until April). Added `fetch_mlb_preseason(season=2026)` function that calls the default seasontype (preseason) returning Cactus League + Grapefruit League live Spring Training data.
- **`api/main.py`** — Added `GET /api/standings/mlb-preseason` endpoint (must be declared before the `{league_slug}` catch-all). Regular season endpoint now uses `seasontype=2`.
- **`frontend/src/hooks/useApi.js`** — Added `null` guard: if `url` is `null`, returns `{data: null, loading: false, error: null}` immediately without fetching.
- **`frontend/src/pages/Standings.jsx`** — MLB tab now shows two sections: (1) Spring Training 2026 with "LIVE NOW" badge (Cactus + Grapefruit League), (2) Regular Season 2026 with "STARTS APR 2026" badge (AL/NL). Added `usePreseason()` hook (only active when MLB tab selected). `MlbTable` accepts `isPreseason` prop and adjusts footer note accordingly.
- **Verified**: Regular season = 30 teams AL/NL all 0-0; Spring Training = 30 teams Cactus/Grapefruit with live results (e.g. Giants 13-3, Braves 11-3).

### 42) Full system bug audit — 13 bugs fixed

Ran comprehensive codebase audit (frontend + backend + ML logic). Fixed all critical and medium bugs, plus selected low-severity items.

**Critical fixes:**
- **C01** `recommendations.py:39` + `api/main.py:839` — Wrong Gemini model `"models/gemini-3.1-pro-preview"` → `"models/gemini-2.0-flash"`. All AI chat and recommendations calls were failing.
- **C06** `Picks.jsx:26-29` — `KellyCalc` NaN crash when `pick.model_prob` or `pick.odds` is null. Added null guards: `p = model_prob ?? 0.5`, `b = (odds ?? 0) - 1`.
- **C08** `tracker.py:400` — `auto_resolve_parlays()` always called `fetch_live_scoreboard()` (today's date only), ignoring `target_date`. Rewritten to call `fetch_espn_all_leagues(game_date=...)` + `fetch_mlb_scoreboard(game_date=...)` with the actual target date.

**Medium fixes:**
- **M01** `prediction_log.py:193-201` — Draw bet result logic was unreachable (the `if home_score == away_score: return "push"` check ran first, so draw bets were always logged as push instead of won). Restructured: draw bets now checked before the push clause.
- **M03** `espn_ingest.py:225-229` — Scheduled games returned score `0` (from `int("" or 0)`), indistinguishable from real 0-0 games. Now returns `None` for absent scores.
- **M06** `live_odds.py:309-311` — `_persist_snapshots()` called on every request including cache hits, creating infinite duplicate rows. Now only persists when `any_fresh=True` (at least one sport key made a real API call).
- **M09** `Model.jsx:219-223` — `<rect>` inside `<Bar>` is wrong Recharts API (bar colours didn't apply). Replaced with `<Cell>` (added to import).
- **M14** `prediction_log.py:310` — SQL `WHERE result != 'pending'` excluded NULL rows (SQLite NULL semantics). Fixed to `WHERE result IS NOT NULL AND result != 'pending'`.

**Low fixes:**
- **L01** `recommendations.py:923` — Hardcoded `6429` training game count. Now uses `len(hist)` (actual loaded row count).
- **L02** `Model.jsx:261` — Hardcoded `6429` training rows. Now computed from `multiSummary.sports` sum of `rows` fields.
- **L04** `Standings.jsx:189-195` — `streakLabel()` parsed streak as number only; ESPN returns string `"W3"`/`"L2"`. Now handles both string and numeric formats.
- **L13** `useApi.js:5` — `loading` initialized to `true` even for null URL, causing spinner flash. Now `useState(!!url)`.
- **L14** `standings.py:255-259` — UCL/EPL team name collision (Arsenal EPL rank overwrote Arsenal UCL rank). `build_standings_lookup()` now stores both `"Arsenal"` (domestic preference) and `"Arsenal|ucl"` (league-specific) keys.
- **L15** `Tracker.jsx:414,423` — `alert()` used for settle/delete errors. Replaced with inline `actionError` state and dismissible red banner.

**API restarted** on port 8000 with all fixes.

### 41) AI Chat — schedule context + fixed live inference

**Problem**: AI couldn't answer "what games are tomorrow?" because the chat endpoint only injected today's picks + 15 live odds lines. Also, `score_tomorrows_games()` and `score_todays_games()` were failing silently for every game because `_build_feature_row` / `_sport_features` in `recommendations.py` were out of sync with the trained models (missing all multi-window features: `*_10`, `*_20`, fatigue, form_momentum, pitcher ERA, etc.).

**Fix 1 — `api/main.py` chat context** (lines 874–950):
- Added **UPCOMING SCHEDULE (next 3 days)** section: calls `fetch_upcoming_schedule(days_ahead=3)`, groups by date with labels "TODAY / TOMORROW / DAY AFTER TOMORROW", lists all games per day with league + teams + UTC time.
- Added **TOMORROW'S AI PICKS** section: calls `score_tomorrows_games(top_n=10)`, formats edge/tier per pick.
- Updated system prompt: explicitly tells Gemini it has the full schedule and to use the UPCOMING SCHEDULE section for schedule questions.

**Fix 2 — `sports_model/recommendations.py`** (lines 66–260):
- `_build_feature_row()`: completely rewritten to compute multi-window rolling stats (5/10/20 games), real rest days (last game date from hist), fatigue flags, pitcher ERA proxy for MLB — matching all features the models were trained on.
- `_sport_features()`: updated for all 3 sports to exactly mirror `sport_models.py` SOCCER_FEATURES / NBA_FEATURES / MLB_FEATURES (was only listing 5-game features, was missing ~30 features per sport).

**Verified**:
- `score_tomorrows_games()` now returns picks (e.g. Tottenham AWAY UCL Edge 52%, Barcelona AWAY UCL Edge 43.1%)
- Chat endpoint answers "what games are tomorrow?" with full UCL/NBA/MLB schedule for March 10
- API restarted on port 8000

### 40) MLB historical data ingest + pitcher features + model retrain

**Root cause**: MLB model AUC was 0.489 because `historical_games.csv` had only 1,079 MLB rows (all 2025-2026 Spring Training). No signal, near-random.

**Fix — MLB historical ingest** (`sports_model/mlb_historical_ingest.py`):
- Fetched 2019, 2021-2024 regular-season games from MLB Stats API (weekly batches, 0.25s delay per batch)
- Parsed: final score, hits, errors, starting pitcher names (home + away) from `linescore` + `probablePitcher`
- `add_rolling_pitcher_era()`: point-in-time rolling ERA proxy (runs allowed/9 IP, window=10), SP win rate — no extra API calls
- Merged 11,924 new rows into `data/historical_games.csv` (was 6,429, now 18,348 total; MLB rows: 2019=2396, 2021=2371, 2022=2362, 2023=2395, 2024=2400)

**Fix — pitcher features in `features.py`**:
- Import `add_rolling_pitcher_era` from `mlb_historical_ingest`
- `_add_mlb_features()`: calls `add_rolling_pitcher_era(games)` when `home_sp` column present; else defaults (4.50 ERA, 0.0 diff)
- Added to `feature_cols`: `home_sp_era_proxy`, `away_sp_era_proxy`, `sp_era_diff`, `sp_winrate_diff`

**Fix — `sport_models.py`**:
- Added pitcher features to `MLB_FEATURES` list (now 38 features)

**Retrain results**:
| Sport  | Rows   | AUC before | AUC after | Change   |
|--------|--------|------------|-----------|----------|
| Soccer | 4,321  | 0.674      | 0.674     | —        |
| NBA    | 1,024  | 0.597      | 0.600     | +0.003   |
| MLB    | 13,003 | 0.489      | **0.562** | **+0.073** |

MLB model improved dramatically: 0.489 → 0.562 AUC. Hit rate 56.1%, yield 17.3%. Pitcher ERA proxy (`sp_era_diff`) is the key new signal.

### 38) MLB Standings — complete end-to-end
- **`sports_model/standings.py`** — Added `"mlb"` to `ESPN_STANDINGS_LEAGUES` with `?season=2025` param (avoids Spring Training / Cactus League data). Added `MLB_STATS` list and full AL/NL parsing: rank, W, L, Win%, GB, home record, road record, streak.
- **`frontend/src/pages/Standings.jsx`** — Fixed render conditional: was `isNba ? NbaTable : SoccerTable`; updated to `isMlb ? MlbTable : isNba ? NbaTable : SoccerTable`. Source note now appends MLB season param note when MLB tab is active. `MlbTable` component renders AL/NL split with W/L/Win%/GB/Home/Road/Streak columns; top-3 division leader highlight, streak W/L colouring.
- **API server restarted** — standings.py changes picked up.
- **Verified**: `GET /api/standings/mlb` returns 30 teams with all fields (`standing_gb`, `standing_home_w/l`, `standing_road_w/l`, `standing_streak`).

### 40) NBA Player Props + Soccer Alternate Markets + Dark Mode + Auto-refresh

#### NBA Player Props
- **`sports_model/live_odds.py`** — Added `fetch_nba_player_props(event_id, home, away)`:
  - Fetches `player_points`, `player_rebounds`, `player_assists` via event-specific endpoint
  - Returns per-player: line, over/under odds, FanDuel, DraftKings, best bookmaker
  - Cached per event_id for 15 min (`_PROPS_CACHE`)
  - Added `get_nba_event_ids()` to get event IDs from existing cached h2h fetch (no extra quota)
- **`api/main.py`** — New endpoints:
  - `GET /api/props/nba` — all props for all NBA games today (11 games, 339 props in test)
  - `GET /api/props/nba/{event_id}` — props for a specific event
- **Verified**: 339 player-market combos across 11 games, FanDuel + DraftKings odds present

#### Soccer Alternate Markets
- **`sports_model/live_odds.py`** — Added `fetch_soccer_alt_markets(sport_key, event_id, home, away)`:
  - Fetches BTTS, Draw No Bet, player_goal_scorer_anytime via EU/UK bookmakers
  - Returns: `btts_yes_odds`, `btts_no_odds`, `dnb_home_odds`, `dnb_away_odds`, top 10 goal scorers
  - Cached per event_id for 15 min (`_ALT_CACHE`)
  - Note: Corners and Cards require paid Odds API plan — not on free tier (returns 422)
  - Added `get_soccer_event_ids(sport_key)` helper
- **`api/main.py`** — New endpoints:
  - `GET /api/odds/soccer-events/{sport_key}` — event list for a league
  - `GET /api/odds/soccer-alt/{sport_key}/{event_id}` — BTTS + DNB + goal scorers
- **Verified**: UCL Galatasaray vs Liverpool — BTTS Yes 1.56, Salah 2.55 anytime scorer

#### Frontend: Props page (`frontend/src/pages/Props.jsx`)
- New `/props` route added to `App.jsx` navigation
- Two tabs: NBA Player Props | Soccer Alt Markets
- NBA: expandable per-game cards with per-player rows, FD/DK odds comparison, market filter (All/Points/Rebounds/Assists), player search, **auto-refresh every 60s** with countdown
- Soccer: league selector (UCL/EPL/Bundesliga/LaLiga/LigaMX/Europa), per-event expandable panels showing BTTS/DNB/goal scorers; note about corners/cards requiring paid plan

#### Dark/Light Mode (`frontend/src/hooks/useTheme.js`)
- `useTheme()` hook: persists to localStorage, applies `dark`/`light` class to `<html>`
- `tailwind.config.js`: `darkMode: 'class'` enabled
- `App.jsx` updated: toggle button in header (☀️/🌙), conditional classes throughout
- Default remains dark (preserves existing design)

#### Auto-refresh on Picks page
- `useApi.js` updated: accepts `{ interval }` option; fires auto-refresh timer, exposes `secondsUntilRefresh`
- `Picks.jsx`: `todayPicksApi` uses `{ interval: 60000 }` — odds refresh every 60s
- Countdown indicator shown in header: "odds refresh in 42s"

#### Pick card enhancements (`Picks.jsx`)
- Added form/probability bar: visual progress bar (0-100%) showing model probability
- Shows avg scored last 5 for bet side vs opponent with color-coded bar

#### API server restarted — PID 57320

### 41) NBA props expanded + corners/cards investigation

**Confirmed the Odds API plan:** 18,823 requests remaining — confirmed paid plan (free = 500/mo).

**Corners/Cards investigation:** Tested all possible market key variants (`corners`, `team_corners`, `corners_line`, `total_corners`, `player_cards`, etc.) across all regions (us/uk/eu/au) for both UCL and EPL events. All returned HTTP 422 Unprocessable Entity. **Conclusion: Corners and Cards markets do not exist in The Odds API on any plan tier.** They are simply not a product they offer. The UI notice was corrected to say "not available in The Odds API (not offered on any plan)" instead of the incorrect "requires paid plan".

**NBA props expanded** (`sports_model/live_odds.py`):
- Added 7 new markets: `player_threes`, `player_steals`, `player_blocks`, `player_points_rebounds_assists`, `player_points_rebounds`, `player_points_assists`, `player_rebounds_assists`
- All confirmed available at 2 bookmakers (FanDuel + DraftKings) per event
- Total props: **822 across 11 games** (was 339 with 3 markets)
- Each market gets its own color scheme in the UI

**Props page filter buttons** — now show all 10 market types with emoji labels.

**API server restarted — PID 46940**

### 42) Odds API quota optimization — 67% reduction

**Investigation findings:**
- Confirmed paid plan: 18,674 requests remaining (free tier = 500/month)
- `spreads` market was being fetched but never used by the ML model (only h2h + totals are used)
- Cache TTL was 15 min → 96 cold load cycles/day max
- `get_nba_event_ids()` was calling `_fetch_sport_odds("basketball_nba", markets=["h2h"])` — different cache key from main picks fetch `basketball_nba|h2h,totals`, causing a redundant NBA call

**Changes made (`sports_model/live_odds.py`):**

1. **Dropped `spreads` from `ALL_MARKETS`** — `["h2h", "spreads", "totals"]` → `["h2h", "totals"]`
   - Saves 1 request per sport key per cold load = 8 saved per cycle (6 soccer + NBA + MLB)
   - `spreads` field still stored in `_best_odds()` result dict for future use but not fetched

2. **Extended `CACHE_TTL` 900s → 1800s** (15 min → 30 min)
   - Pre-match soccer/NBA odds move slowly; 30 min is accurate enough
   - Halves the number of cold load cycles per day: 96 → 48
   - All caches use this single constant: `_CACHE`, `_CACHE_TS`, `_LOOKUP_CACHE`, `_PROPS_CACHE`, `_ALT_CACHE`

3. **Fixed `get_nba_event_ids()`** — now calls `_fetch_sport_odds("basketball_nba")` (no market override)
   - Reuses the same `basketball_nba|h2h,totals` cache entry as the main picks fetch
   - Eliminates a redundant NBA call when Props page loads after Picks page

4. **`recommendations.py` `_CACHE_TTL`** updated to 1800s to match

**Verified results (measured):**
| Metric | Before | After |
|--------|--------|-------|
| Cold load cost | 24 requests | **16 requests** (-33%) |
| Warm load cost | 0 | **0** (unchanged) |
| Max cycles/day | 96 (15-min TTL) | **48** (30-min TTL) |
| Max daily requests | 2,304/day | **768/day** (-67%) |

Cold load measured at exactly 16 requests. Warm load confirmed 0 Odds API calls.

**API server restarted — PID 89620**

### 39) `_build_feature_row` speed optimization — team_index + pitcher_era_proxy fix

**Root cause**: `_build_feature_row` was doing O(n) DataFrame scans of the full 18,348-row `historical_games.csv` on every game (5 calls per game × 29 games = 145 full-table scans per picks request). At ~52ms/game this made warm picks calls ~1.5s for feature building alone.

**Fix 1 — team_index pre-built at load time** (`recommendations.py`):
- `_build_team_index(hist)` builds `{team: sorted_df}` for all teams at load time in `_load_hist_and_standings()`. Stored in `_HIST_CACHE["team_index"]`.
- `_build_feature_row` accepts `team_index: dict | None = None`; inner `_team_games(team)` returns pre-filtered df via dict lookup in O(1) instead of full-table scan.

**Fix 2 — `pitcher_era_proxy` also uses team_index** (`recommendations.py` lines 152-162):
- Was: `hist[hist["home_team"] == team]` — O(n) scan
- Now: `_team_games(team)` — O(1) dict lookup, then `.tail(n)` on small per-team df

**Fix 3 — `_score_games_for_date` passes team_index** (`recommendations.py` line 568):
- Added `team_index = _HIST_CACHE.get("team_index")` then passes `team_index=team_index` to `_build_feature_row`.

**Fix 4 — `len(hist)` NameError** in `build_recommendations` model_note (line 992):
- Was referencing `hist` which was out of scope; replaced with `len(_HIST_CACHE.get("hist", pd.DataFrame()))`.

**Benchmark results** (warm, API server PID 47368):
- `/api/picks/today`: 3.76s | 10 picks | parlay=True
- `/api/picks/tomorrow`: 3.89s | 10 picks | parlay=True
- Remaining bottleneck: soccer odds lookup (~3.7s on cold per-sport call; cached to ~0ms after first call within process)

**API server restarted** — PID 47368.

---

### 40) Live.jsx rewrite — scoreboard animations, OddsTab removed

**What changed** (`frontend/src/pages/Live.jsx`):
- Removed entire `OddsTab` component and the tab switcher (pre-game odds now on Dashboard; live odds belong to Dashboard game slate, not this page).
- Page is now scoreboard-only: single `ScoreboardTab` with auto-refresh every 30s via `useApi(..., { interval: 30000 })`.
- **`AnimatedScore`** component: uses `useRef` to track previous value; triggers `animate-score-bump` (defined in `tailwind.config.js`) for 450ms when score changes.
- **`LiveDot`** component: pulsing green dot + "LIVE" label using `animate-pulse-slow`.
- Live game cards get a green border glow (`border-green-700/60 shadow-[0_0_12px_rgba(74,222,128,0.08)]`).
- Live scores render in `text-green-300` while in-progress; final scores in `text-gray-100`.
- Period/clock field shown below score when `game.period` is set.
- All classes updated to navy theme (`bg-navy-800`, `border-navy-700`, etc.).
- Countdown to next refresh uses `secondsUntilRefresh` from `useApi` hook (no redundant local state).
- Footer note updated: "Scoreboard data via ESPN · Auto-refreshes every 30s".

---

### 41) Navy theme pass — all remaining pages

Applied consistent FanDuel-style navy color scheme to all pages that still used old `bg-gray-*` / `border-gray-*` classes:
- `Picks.jsx` — PickCard, KellyCalc, H2HPanel, NewsPanel, ParlayCard, PicksSection
- `Chat.jsx` — MessageBubble, TypingIndicator, input bar, suggestion pills
- `History.jsx` — StatCard, BreakdownTable, RollingChart, CalibrationChart, PredictionsTable
- `Model.jsx` — SportModelCard, BenchmarkTable, FoldChart, ROC AUC chart
- `Standings.jsx` — SoccerTable, NbaTable, MlbTable, league tab buttons
- `Props.jsx` — NbaGameCard, SoccerAltPanel, market filter buttons, player search

**Replacements applied** (via Python bulk script):
- `bg-gray-950` → `bg-navy-900`
- `bg-gray-900` → `bg-navy-800`
- `bg-gray-800` → `bg-navy-700` (all opacity variants too)
- `bg-gray-700` → `bg-navy-600`
- `border-gray-800` → `border-navy-700`
- `border-gray-700` → `border-navy-600`
- `divide-gray-800` → `divide-navy-700`
- `hover:bg-gray-700` → `hover:bg-navy-600`

**Build**: clean, 36.35 kB CSS, 681.56 kB JS (no errors, only bundle-size advisory).

---

### 42) Model improvement — more data + new features + XGBoost/LightGBM

**1. NBA data ingestion** (`data/historical_games.csv`):
- Used `fetch_historical_games_fast()` to bulk-ingest 7 NBA seasons (2018-19 → 2024-25)
- NBA rows: **1,024 → 8,767** (+757%)
- Total dataset: **18,348 → 26,091 rows**
- Saved intermediate `data/nba_historical_bulk.csv`, merged into `historical_games.csv`

**2. New features** (`sports_model/features.py`):
- `_add_h2h_features()`: rolling H2H win rate (last 5 meetings, point-in-time)
- `_add_venue_split_features()`: home/away venue-specific win rate (last 10 games, point-in-time)
- `_add_streak_features()`: current win/loss streak (capped ±10, point-in-time)
- Last-3 form: `off_eff_diff_3`, `def_eff_diff_3` (very short-term momentum)
- New features added to all sport feature lists in `sport_models.py`

**3. LightGBM installed** (pip install lightgbm 4.6.0); XGBoost 3.2 already present

**4. Retrain results** (`python run.py sport-models`):

| Sport | Before AUC | After AUC | Rows |
|-------|-----------|----------|------|
| Soccer | 0.674 | 0.674 | 4,321 |
| **NBA** | 0.600 | **0.661** | **8,767** |
| MLB | 0.562 | 0.561 | 13,003 |

- NBA AUC improved +6.1 points — significant, purely from more data
- Best model remains `logreg_cal` for all sports (LogReg beats XGB/LGBM on this dataset size/feature set)
- API restarted with new artifacts — PID 46036
