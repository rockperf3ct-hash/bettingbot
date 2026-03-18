"""
NBA player game log fetcher via ESPN box scores (free, no auth, no anti-bot).

Strategy:
  1. Fetch recent completed NBA game IDs from ESPN scoreboard (last 14 days)
  2. For each game, fetch box score and extract per-player stats
  3. Build a {player_name: [game_stats]} lookup cached in memory
  4. Use rolling stats to generate Over/Under predictions vs prop lines

No stats.nba.com (blocks backend), no basketball-reference (403),
no balldontlie (now paid). ESPN box scores work fine server-side.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone, timedelta
from difflib import get_close_matches
from typing import Any

import requests

logger = logging.getLogger(__name__)

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "sports-model/1.0 (educational)"})

# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------

_GAME_IDS_CACHE:  tuple[list[str], float] | None = None
_GAME_IDS_TTL = 3600          # 1 hour

_BOX_CACHE: dict[str, dict] = {}          # game_id -> box stats dict
_BOX_TTL   = 3600 * 6                     # 6 hours (completed games don't change)

_PLAYER_LOG_CACHE: dict[str, tuple[list[dict], float]] = {}  # player -> (games, ts)
_PLAYER_LOG_TTL = 1800                    # 30 min

_EVENT_CTX_CACHE: dict[str, tuple[dict[str, Any], float]] = {}
_EVENT_CTX_TTL = 900

_NBA_STANDINGS_CACHE: tuple[dict[str, dict[str, Any]], float] | None = None
_NBA_STANDINGS_TTL = 3600

_PLAYER_SEASON_CACHE: dict[str, tuple[dict[str, Any], float]] = {}
_PLAYER_SEASON_TTL = 3600

_TEAM_CTX_CACHE: dict[str, tuple[dict[str, Any], float]] = {}
_TEAM_CTX_TTL = 1800

MARKET_STAT_COL = {
    "player_points":    "PTS",
    "player_rebounds":  "REB",
    "player_assists":   "AST",
    "player_threes":    "3PT",
    "player_steals":    "STL",
    "player_blocks":    "BLK",
    "player_points_rebounds_assists": "PRA",
    "player_points_rebounds":         "PR",
    "player_points_assists":          "PA",
    "player_rebounds_assists":        "RA",
}

# ---------------------------------------------------------------------------
# ESPN helpers
# ---------------------------------------------------------------------------

def _get(url: str, params: dict | None = None) -> dict:
    try:
        r = _SESSION.get(url, params=params, timeout=12)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        logger.warning("ESPN request failed %s: %s", url, exc)
        return {}


def _norm_team(name: str) -> str:
    return str(name or "").strip().lower()


def _norm_name(name: str) -> str:
    out = ''.join(ch.lower() if (ch.isalnum() or ch.isspace()) else ' ' for ch in str(name or ''))
    return ' '.join(out.split())


def _same_player_name(query: str, cand: str) -> bool:
    q = _norm_name(query).split()
    c = _norm_name(cand).split()
    if len(q) < 2 or len(c) < 2:
        return _norm_name(query) == _norm_name(cand)
    if q[-1] != c[-1]:
        return False
    return q[0] == c[0] or q[0][0] == c[0][0]


def _athlete_id_from_headshot(url: str) -> str:
    m = re.search(r"/full/(\d+)\.png", str(url or ""))
    return m.group(1) if m else ""


def _season_label(season_year: int) -> str:
    prev = str(season_year - 1)[-2:]
    cur = str(season_year)[-2:]
    return f"{prev}-{cur}"


def _fetch_player_season_overview(player_name: str, athlete_id: str) -> dict[str, Any]:
    if not athlete_id:
        return {}
    now = time.time()
    cached = _PLAYER_SEASON_CACHE.get(athlete_id)
    if cached and now - cached[1] < _PLAYER_SEASON_TTL:
        return cached[0]

    out: dict[str, Any] = {}
    try:
        athlete = requests.get(
            f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/{athlete_id}",
            timeout=10,
        ).json()
        season_year = datetime.now(timezone.utc).year
        stats = requests.get(
            f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/{season_year}/types/2/athletes/{athlete_id}/statistics/0",
            timeout=10,
        ).json()

        by_name: dict[str, str] = {}
        for cat in ((stats.get("splits") or {}).get("categories") or []):
            for s in (cat.get("stats") or []):
                nm = str(s.get("name") or "")
                dv = s.get("displayValue")
                if nm and dv is not None and nm not in by_name:
                    by_name[nm] = str(dv)

        out = {
            "season": f"{_season_label(season_year)} Regular Season",
            "player": player_name,
            "position": ((athlete.get("position") or {}).get("abbreviation") if isinstance(athlete.get("position"), dict) else "") or "",
            "number": athlete.get("jersey") or "",
            "age": athlete.get("age") or "",
            "height": athlete.get("displayHeight") or "",
            "weight": athlete.get("displayWeight") or "",
            "experience": ((athlete.get("experience") or {}).get("years") if isinstance(athlete.get("experience"), dict) else "") or "",
            "ppg": by_name.get("avgPoints"),
            "rpg": by_name.get("avgRebounds"),
            "apg": by_name.get("avgAssists"),
            "spg": by_name.get("avgSteals"),
            "bpg": by_name.get("avgBlocks"),
            "mpg": by_name.get("avgMinutes"),
            "fg_pct": by_name.get("fieldGoalPct"),
            "tp_pct": by_name.get("threePointPct"),
            "ft_pct": by_name.get("freeThrowPct"),
            "ts_pct": by_name.get("trueShootingPct"),
            "gp": by_name.get("gamesPlayed"),
        }
    except Exception:
        out = {}

    _PLAYER_SEASON_CACHE[athlete_id] = (out, now)
    return out


def _team_context_metrics(team_name: str, opp_name: str, player_pos_bucket: str, stat_col: str) -> dict[str, float]:
    key = f"{team_name}|{opp_name}|{player_pos_bucket}|{stat_col}"
    now = time.time()
    cached = _TEAM_CTX_CACHE.get(key)
    if cached and now - cached[1] < _TEAM_CTX_TTL:
        return cached[0]

    ids = _fetch_recent_game_ids(days_back=20)
    # Ensure we have boxes in cache
    for gid in ids[:80]:
        _fetch_box_score(gid)

    opp_allowed_vals: list[float] = []
    league_pos_vals: list[float] = []
    team_pace_vals: list[float] = []
    league_pace_vals: list[float] = []

    # Build game aggregates for pace proxy
    game_team_pts: dict[tuple[str, str], float] = {}
    for box in _BOX_CACHE.values():
        for rec in box.values():
            g_id = str(rec.get("game_id") or "")
            t = str(rec.get("team") or "")
            pts = float(rec.get("PTS") or 0)
            if g_id and t:
                game_team_pts[(g_id, t)] = game_team_pts.get((g_id, t), 0.0) + pts

    # League pace samples (sum of both team points in each game)
    seen_g = set()
    for (g_id, t), pts in game_team_pts.items():
        if g_id in seen_g:
            continue
        # collect both teams in this game id
        both = [v for (gid, _t), v in game_team_pts.items() if gid == g_id]
        if len(both) >= 2:
            league_pace_vals.append(sum(both[:2]))
        seen_g.add(g_id)

    for box in _BOX_CACHE.values():
        for rec in box.values():
            posb = str(rec.get("position_bucket") or "U")
            sval = rec.get(stat_col)
            if isinstance(sval, (int, float)):
                if posb == player_pos_bucket:
                    league_pos_vals.append(float(sval))
                if str(rec.get("opponent") or "") == opp_name and posb == player_pos_bucket:
                    opp_allowed_vals.append(float(sval))

            # team pace proxy in games involving player's team
            if str(rec.get("team") or "") == team_name:
                g_id = str(rec.get("game_id") or "")
                if g_id:
                    both = [v for (gid, _t), v in game_team_pts.items() if gid == g_id]
                    if len(both) >= 2:
                        team_pace_vals.append(sum(both[:2]))

    opp_allowed = (sum(opp_allowed_vals) / len(opp_allowed_vals)) if opp_allowed_vals else 0.0
    league_pos_avg = (sum(league_pos_vals) / len(league_pos_vals)) if league_pos_vals else 1.0
    defense_vs_pos_score = max(-1.0, min(1.0, (opp_allowed - league_pos_avg) / max(league_pos_avg, 1.0)))

    team_pace = (sum(team_pace_vals[:12]) / len(team_pace_vals[:12])) if team_pace_vals else 0.0
    league_pace = (sum(league_pace_vals[:200]) / len(league_pace_vals[:200])) if league_pace_vals else 1.0
    pace_score = max(-1.0, min(1.0, (team_pace - league_pace) / max(league_pace, 1.0)))

    out = {
        "defense_vs_pos_score": round(defense_vs_pos_score, 3),
        "opp_allowed_vs_pos": round(opp_allowed, 2),
        "league_pos_avg": round(league_pos_avg, 2),
        "pace_score": round(pace_score, 3),
        "team_pace_proxy": round(team_pace, 2),
        "league_pace_proxy": round(league_pace, 2),
    }
    _TEAM_CTX_CACHE[key] = (out, now)
    return out


def _injury_weight(status: str) -> float:
    s = (status or "").lower()
    if "out" in s:
        return 1.0
    if "doubt" in s:
        return 0.75
    if "question" in s or "gtd" in s:
        return 0.45
    return 0.25


def _pos_bucket(pos: str) -> str:
    p = (pos or "").upper()
    if p in ("PG", "SG", "G"):
        return "G"
    if p in ("SF", "PF", "F"):
        return "F"
    if p in ("C",):
        return "C"
    return "U"


def _nba_standings_lookup() -> dict[str, dict[str, Any]]:
    global _NBA_STANDINGS_CACHE
    now = time.time()
    if _NBA_STANDINGS_CACHE and now - _NBA_STANDINGS_CACHE[1] < _NBA_STANDINGS_TTL:
        return _NBA_STANDINGS_CACHE[0]
    try:
        from sports_model.standings import fetch_espn_standings, build_standings_lookup
        df = fetch_espn_standings("nba")
        lk = build_standings_lookup(df)
    except Exception as exc:
        logger.debug("NBA standings lookup unavailable: %s", exc)
        lk = {}
    _NBA_STANDINGS_CACHE = (lk, now)
    return lk


def _event_context(event_id: str, team_name: str, opp_name: str) -> dict[str, Any]:
    if not event_id:
        return {
            "team_injury": 0.0,
            "opp_injury": 0.0,
            "importance": 0.5,
            "team_pos_injury": {},
            "opp_pos_injury": {},
        }

    now = time.time()
    cached = _EVENT_CTX_CACHE.get(event_id)
    if cached and now - cached[1] < _EVENT_CTX_TTL:
        ctx = cached[0]
    else:
        s = _get(f"{ESPN_BASE}/summary", params={"event": event_id})
        inj_by_team: dict[str, float] = {}
        inj_by_team_pos: dict[str, dict[str, float]] = {}

        def _consume_inj(summary_obj: dict) -> None:
            for t in summary_obj.get("injuries", []) or []:
                tname = (t.get("team", {}) or {}).get("displayName", "")
                tkey = _norm_team(tname)
                sev = 0.0
                pos_map = inj_by_team_pos.setdefault(tkey, {"G": 0.0, "F": 0.0, "C": 0.0, "U": 0.0})
                for item in t.get("injuries", []) or []:
                    w = _injury_weight(item.get("status", ""))
                    sev += w
                    pos = ((item.get("athlete", {}) or {}).get("position", {}) or {}).get("abbreviation", "")
                    pos_map[_pos_bucket(pos)] += w
                inj_by_team[tkey] = sev

        _consume_inj(s)

        # Fallback for non-ESPN event IDs (e.g. Odds API event IDs):
        # locate ESPN event by team names in yesterday/today/tomorrow scoreboards.
        if not inj_by_team and team_name and opp_name:
            try:
                now_dt = datetime.now(timezone.utc)
                for day_off in (-1, 0, 1):
                    dstr = (now_dt + timedelta(days=day_off)).strftime("%Y%m%d")
                    sb = _get(f"{ESPN_BASE}/scoreboard", params={"dates": dstr})
                    for ev in sb.get("events", []) or []:
                        comp = (ev.get("competitions") or [{}])[0]
                        names = {(c.get("team", {}) or {}).get("displayName", "") for c in comp.get("competitors", [])}
                        if team_name in names and opp_name in names:
                            espn_id = ev.get("id")
                            if espn_id:
                                _consume_inj(_get(f"{ESPN_BASE}/summary", params={"event": espn_id}))
                            break
                    if inj_by_team:
                        break
            except Exception:
                pass

        ctx = {
            "inj_by_team": inj_by_team,
            "inj_by_team_pos": inj_by_team_pos,
        }
        _EVENT_CTX_CACHE[event_id] = (ctx, now)

    inj_by_team = ctx.get("inj_by_team", {})
    team_injury = float(inj_by_team.get(_norm_team(team_name), 0.0))
    opp_injury = float(inj_by_team.get(_norm_team(opp_name), 0.0))
    inj_by_team_pos = ctx.get("inj_by_team_pos", {})
    team_pos_injury = inj_by_team_pos.get(_norm_team(team_name), {"G": 0.0, "F": 0.0, "C": 0.0, "U": 0.0})
    opp_pos_injury = inj_by_team_pos.get(_norm_team(opp_name), {"G": 0.0, "F": 0.0, "C": 0.0, "U": 0.0})

    importance = 0.5
    try:
        lk = _nba_standings_lookup()
        tr = lk.get(team_name) or {}
        orr = lk.get(opp_name) or {}
        rank_t = tr.get("standing_rank")
        rank_o = orr.get("standing_rank")
        wp_t = tr.get("standing_win_pct")
        wp_o = orr.get("standing_win_pct")
        close_rank = 1.0 - min(abs((rank_t or 8) - (rank_o or 8)) / 10.0, 1.0)
        close_wp = 1.0 - min(abs((wp_t or 0.5) - (wp_o or 0.5)) / 0.35, 1.0)
        playoff_push_t = max(0.0, (12 - float(rank_t or 12)) / 12.0)
        playoff_push_o = max(0.0, (12 - float(rank_o or 12)) / 12.0)
        importance = 0.35 * close_rank + 0.35 * close_wp + 0.30 * ((playoff_push_t + playoff_push_o) / 2.0)
        importance = max(0.1, min(0.95, float(importance)))
    except Exception:
        pass

    return {
        "team_injury": team_injury,
        "opp_injury": opp_injury,
        "importance": importance,
        "team_pos_injury": team_pos_injury,
        "opp_pos_injury": opp_pos_injury,
    }


def _fetch_recent_game_ids(days_back: int = 10) -> list[str]:
    """
    Collect completed NBA game IDs from the last N days via ESPN scoreboard.
    Returns list of ESPN event IDs (strings).
    """
    global _GAME_IDS_CACHE
    now = time.time()
    if _GAME_IDS_CACHE:
        ids, ts = _GAME_IDS_CACHE
        if now - ts < _GAME_IDS_TTL:
            return ids

    game_ids: list[str] = []
    today = datetime.now(timezone.utc).date()

    for d in range(0, days_back):
        target = today - timedelta(days=d)
        date_str = target.strftime("%Y%m%d")
        data = _get(f"{ESPN_BASE}/scoreboard", params={"dates": date_str})
        for event in data.get("events", []):
            status = event.get("status", {}).get("type", {}).get("name", "")
            if "Final" in status or "final" in status.lower():
                game_ids.append(event["id"])
        time.sleep(0.2)

    logger.info("NBA box: found %d completed games in last %d days", len(game_ids), days_back)
    _GAME_IDS_CACHE = (game_ids, now)
    return game_ids


def _fetch_box_score(game_id: str) -> dict[str, dict]:
    """
    Fetch box score for a game. Returns {player_name: {PTS, REB, AST, ...}}.
    Cached per game_id.
    """
    if game_id in _BOX_CACHE:
        return _BOX_CACHE[game_id]

    data = _get(f"{ESPN_BASE}/summary", params={"event": game_id})
    if not data:
        return {}

    boxscore = data.get("boxscore", {})
    comp = ((data.get("header", {}) or {}).get("competitions", [{}]) or [{}])[0]
    game_date = str(comp.get("date", ""))[:10]
    competitors = comp.get("competitors", []) or []
    team_name_by_id: dict[str, str] = {}
    for c in competitors:
        t = c.get("team", {}) or {}
        tid = str(t.get("id", "") or "")
        if tid:
            team_name_by_id[tid] = t.get("displayName", "")
    player_stats: dict[str, dict] = {}

    for team_obj in boxscore.get("players", []):
        team_meta = team_obj.get("team", {}) or {}
        team_id = str(team_meta.get("id", "") or "")
        team_name = team_meta.get("displayName", "")
        team_abbr = team_meta.get("abbreviation", "")
        team_logo = team_meta.get("logo", "")
        opp_name = ""
        for tid, nm in team_name_by_id.items():
            if tid != team_id:
                opp_name = nm
                break
        for stats_obj in team_obj.get("statistics", []):
            keys = stats_obj.get("keys", [])
            for athlete_obj in stats_obj.get("athletes", []):
                if athlete_obj.get("didNotPlay"):
                    continue
                name = athlete_obj.get("athlete", {}).get("displayName", "")
                headshot = (athlete_obj.get("athlete", {}).get("headshot", {}) or {}).get("href", "")
                pos = ((athlete_obj.get("athlete", {}).get("position", {}) or {}).get("abbreviation", ""))
                raw  = athlete_obj.get("stats", [])
                if not name or not raw:
                    continue

                g: dict[str, Any] = {}
                for k, v in zip(keys, raw):
                    # Parse fraction stats like "7-11"
                    if "-" in str(v) and k not in ("plusMinus",):
                        try:
                            made, att = str(v).split("-")
                            # Use made for counting stats
                            g[k.split("-")[0]] = int(made)
                        except Exception:
                            pass
                    else:
                        try:
                            g[k] = int(v) if str(v).lstrip("-").isdigit() else v
                        except Exception:
                            g[k] = v

                # Normalize key names to short labels
                pts = int(g.get("points",    0) or 0)
                reb = int(g.get("rebounds",  0) or 0)
                ast = int(g.get("assists",   0) or 0)
                stl = int(g.get("steals",    0) or 0)
                blk = int(g.get("blocks",    0) or 0)
                fg3 = int(g.get("threePointFieldGoalsMade", 0) or 0)
                fga = int(g.get("fieldGoalsAttempted", 0) or 0)
                tpa = int(g.get("threePointFieldGoalsAttempted", 0) or 0)
                mins_raw = g.get("minutes", "0")
                try:
                    mins = int(str(mins_raw).split(":")[0])
                except Exception:
                    mins = 0

                if mins < 5:
                    continue  # skip DNP / garbage time

                player_stats[name] = {
                    "PTS": pts,
                    "REB": reb,
                    "AST": ast,
                    "STL": stl,
                    "BLK": blk,
                    "3PT": fg3,
                    "FGA": fga,
                    "3PA": tpa,
                    "PRA": pts + reb + ast,
                    "PR":  pts + reb,
                    "PA":  pts + ast,
                    "RA":  reb + ast,
                    "MIN": mins,
                    "game_id": game_id,
                    "date": game_date,
                    "team": team_name,
                    "team_abbr": team_abbr,
                    "team_logo": team_logo,
                    "opponent": opp_name,
                    "player_headshot": headshot,
                    "position": pos,
                    "position_bucket": _pos_bucket(pos),
                }

    _BOX_CACHE[game_id] = player_stats
    return player_stats


# ---------------------------------------------------------------------------
# Player game log builder
# ---------------------------------------------------------------------------

def get_player_game_log(player_name: str, n_games: int = 10) -> list[dict]:
    """
    Build last N game logs for a player from ESPN box scores.
    Uses fuzzy name matching.
    """
    now = time.time()
    target_n = max(n_games, 12)
    if player_name in _PLAYER_LOG_CACHE:
        cached, ts = _PLAYER_LOG_CACHE[player_name]
        if now - ts < _PLAYER_LOG_TTL and len(cached) >= n_games:
            return cached[:n_games]

    game_ids = _fetch_recent_game_ids()
    if not game_ids:
        return []

    player_games: list[dict] = []
    matched_name: str | None = None

    for gid in game_ids:
        box = _fetch_box_score(gid)
        if not box:
            continue

        # Try exact match first, then fuzzy
        if matched_name and matched_name in box and _same_player_name(player_name, matched_name):
            player_games.append(box[matched_name])
        elif player_name in box:
            matched_name = player_name
            player_games.append(box[player_name])
        else:
            candidates = [nm for nm in box.keys() if _same_player_name(player_name, nm)]
            if candidates:
                close = get_close_matches(player_name, candidates, n=1, cutoff=0.88)
                if close:
                    matched_name = close[0]
                    logger.debug("Player fuzzy(strict): '%s' -> '%s'", player_name, matched_name)
                    player_games.append(box[matched_name])

        if len(player_games) >= target_n:
            break

    _PLAYER_LOG_CACHE[player_name] = (player_games, now)
    return player_games


# ---------------------------------------------------------------------------
# Stat aggregation
# ---------------------------------------------------------------------------

def player_stat_rolling(games: list[dict], stat_col: str) -> dict:
    values = [g[stat_col] for g in games if g.get(stat_col) is not None]
    if not values:
        return {"mean": None, "std": None, "last3_mean": None, "last5_mean": None, "last10_mean": None, "n_games": 0, "values": []}

    n = len(values)
    mean   = sum(values) / n
    last3  = values[:3]
    l3mean = sum(last3) / len(last3) if last3 else mean
    last5 = values[:5]
    l5mean = sum(last5) / len(last5) if last5 else mean
    last10 = values[:10]
    l10mean = sum(last10) / len(last10) if last10 else mean
    median = sorted(values)[n // 2]
    std    = (sum((v - mean) ** 2 for v in values) / max(n - 1, 1)) ** 0.5

    return {
        "mean":       round(mean, 2),
        "std":        round(std, 2),
        "median":     round(median, 2),
        "last3_mean": round(l3mean, 2),
        "last5_mean": round(l5mean, 2),
        "last10_mean": round(l10mean, 2),
        "n_games":    n,
        "values":     values,
    }


# ---------------------------------------------------------------------------
# ML prediction
# ---------------------------------------------------------------------------

def predict_prop(
    player_name: str,
    market: str,
    line: float,
    over_odds: float | None = None,
    under_odds: float | None = None,
    n_games: int = 10,
    event_id: str | None = None,
    team_name: str | None = None,
    opponent_name: str | None = None,
    team_odds: float | None = None,
    opp_odds: float | None = None,
    fanduel_line: float | None = None,
    draftkings_line: float | None = None,
) -> dict | None:
    """
    Over/Under prediction using ESPN box score rolling stats.

    Signals:
      - Z-score of rolling mean vs line (45% weight)
      - Last-5 average vs line (35% weight)
      - Hit rate direction (20% weight)

    Returns prediction dict or None if < 3 games found.
    """
    import math

    stat_col = MARKET_STAT_COL.get(market)
    if not stat_col:
        return None

    games = get_player_game_log(player_name, n_games=n_games)
    if not games:
        return None

    stats = player_stat_rolling(games, stat_col)
    if stats["n_games"] < 3:
        return None

    mean   = stats["mean"]
    std    = stats["std"] or 1.0
    l3mean = stats["last3_mean"]
    l5mean = stats.get("last5_mean") or l3mean
    l10mean = stats.get("last10_mean") or l5mean
    values = stats["values"]

    z_score       = (mean   - line) / std
    recency_z     = (l5mean - line) / std
    sample_vals = values[:5] if values[:5] else values
    hit_rate_over = sum(1 for v in sample_vals if v > line) / len(sample_vals)
    hit_rate_under = 1 - hit_rate_over
    recent2 = values[:2] if values[:2] else sample_vals
    prior3 = values[2:5] if values[2:5] else sample_vals
    recent2_avg = sum(recent2) / len(recent2)
    prior3_avg = sum(prior3) / len(prior3)
    momentum_raw = recent2_avg - prior3_avg
    momentum_score = max(-1.0, min(1.0, momentum_raw / max(std, 1.0)))
    mins_values = [float(g.get("MIN", 0) or 0) for g in games if isinstance(g.get("MIN"), (int, float))]
    avg_min_10 = (sum(mins_values[:10]) / len(mins_values[:10])) if mins_values[:10] else 0.0
    avg_min_3 = (sum(mins_values[:3]) / len(mins_values[:3])) if mins_values[:3] else avg_min_10
    minutes_trend = max(-1.0, min(1.0, (avg_min_3 - avg_min_10) / 6.0))
    player_pos = str(next((g.get("position") for g in games if g.get("position")), "") or "")
    player_pos_bucket = _pos_bucket(player_pos)

    # Usage proxy from shot volume trend (if available)
    fga_vals = [float(g.get("FGA") or 0) for g in games if isinstance(g.get("FGA"), (int, float))]
    fga_recent = (sum(fga_vals[:3]) / len(fga_vals[:3])) if fga_vals[:3] else 0.0
    fga_prior = (sum(fga_vals[3:8]) / len(fga_vals[3:8])) if fga_vals[3:8] else (sum(fga_vals) / len(fga_vals) if fga_vals else 0.0)
    usage_trend = max(-1.0, min(1.0, (fga_recent - fga_prior) / max(4.0, fga_prior if fga_prior > 0 else 4.0)))

    # Rest / schedule density
    parsed_dates = []
    for g in games:
        ds = str(g.get("date") or "")
        try:
            parsed_dates.append(datetime.fromisoformat(ds).date())
        except Exception:
            continue
    parsed_dates = sorted(list(set(parsed_dates)), reverse=True)
    days_rest = (parsed_dates[0] - parsed_dates[1]).days if len(parsed_dates) >= 2 else 2
    b2b = 1.0 if days_rest <= 1 else 0.0
    games_last7 = sum(1 for d in parsed_dates if (parsed_dates[0] - d).days <= 7) if parsed_dates else 0
    density_score = max(-1.0, min(1.0, (games_last7 - 3) / 3.0))

    # Starter/minutes reliability
    min_sample = mins_values[:10] if mins_values[:10] else mins_values
    starter_prob = (sum(1 for m in min_sample if m >= 28) / len(min_sample)) if min_sample else 0.0
    minutes_stability = 1.0 - min(1.0, (sum(abs(m - avg_min_10) for m in min_sample) / max(1, len(min_sample))) / 10.0) if min_sample else 0.0

    # Matchup specifics: opponent defense vs position + pace
    tm_ctx = _team_context_metrics(team_name or "", opponent_name or "", player_pos_bucket, stat_col)
    defense_vs_pos_score = float(tm_ctx.get("defense_vs_pos_score", 0.0))
    pace_score = float(tm_ctx.get("pace_score", 0.0))

    # Market alignment / pseudo-CLV signal from line disagreement
    line_consensus_gap = 0.0
    if isinstance(fanduel_line, (int, float)) and isinstance(draftkings_line, (int, float)):
        line_consensus_gap = abs(float(fanduel_line) - float(draftkings_line))
    market_alignment = max(-1.0, min(1.0, 1.0 - (line_consensus_gap / 2.5)))

    # Ensemble core: base + robust-median variant
    base_signal = (0.45 * z_score) + (0.35 * recency_z) + (0.20 * (hit_rate_over - 0.5) * 2)
    median = float(stats.get("median") or mean)
    median_z = (median - line) / std
    robust_signal = (0.40 * median_z) + (0.30 * recency_z) + (0.30 * momentum_score)
    weighted = 0.65 * base_signal + 0.35 * robust_signal

    call = "Over" if weighted > 0 else "Under"
    raw_conf = 0.5 + 0.42 * (1 - math.exp(-0.6 * abs(weighted)))

    # Context adjustments: underdog pressure, injuries, game importance
    underdog_strength = 0.0
    market_side = "unknown"
    if team_odds and opp_odds and team_odds > 1 and opp_odds > 1:
        team_imp = 1 / team_odds
        opp_imp = 1 / opp_odds
        underdog_strength = max(-1.0, min(1.0, (opp_imp - team_imp) / 0.35))
        if team_odds > opp_odds:
            market_side = "underdog"
        elif team_odds < opp_odds:
            market_side = "favorite"
        else:
            market_side = "even"

    ctx = _event_context(event_id or "", team_name or "", opponent_name or "")
    team_injury = min(1.0, (ctx.get("team_injury", 0.0) or 0.0) / 6.0)
    opp_injury = min(1.0, (ctx.get("opp_injury", 0.0) or 0.0) / 6.0)
    team_pos_raw = (ctx.get("team_pos_injury", {}) or {}).get(player_pos_bucket, 0.0)
    team_pos_injury = min(1.0, (team_pos_raw or 0.0) / 3.0)
    injury_adv = max(-1.0, min(1.0, opp_injury - team_injury))
    importance = float(ctx.get("importance", 0.5) or 0.5)
    importance_shift = max(-0.5, min(0.5, importance - 0.5))

    if call == "Over":
        context_shift = (
            0.050 * injury_adv +
            0.035 * team_injury +
            0.030 * underdog_strength +
            0.020 * importance_shift +
            0.040 * momentum_score +
            0.045 * minutes_trend +
            0.030 * team_pos_injury +
            0.035 * defense_vs_pos_score +
            0.020 * pace_score +
            0.030 * usage_trend +
            0.018 * starter_prob +
            0.015 * minutes_stability +
            0.015 * market_alignment -
            0.020 * b2b -
            0.015 * density_score
        )
    else:
        context_shift = (
            -0.050 * injury_adv -
            0.035 * team_injury -
            0.030 * underdog_strength -
            0.020 * importance_shift -
            0.040 * momentum_score -
            0.045 * minutes_trend -
            0.030 * team_pos_injury -
            0.035 * defense_vs_pos_score -
            0.020 * pace_score -
            0.030 * usage_trend -
            0.018 * starter_prob -
            0.015 * minutes_stability -
            0.015 * market_alignment +
            0.020 * b2b +
            0.015 * density_score
        )

    # Per-market calibration (probability shrink/expand)
    cal = {
        "player_points": 0.985,
        "player_rebounds": 0.98,
        "player_assists": 0.975,
        "player_threes": 0.965,
    }.get(market, 0.98)

    # Data quality gate
    quality = 1.0
    if stats["n_games"] < 5:
        quality -= 0.10
    if not team_name or not opponent_name:
        quality -= 0.08
    if team_odds is None or opp_odds is None:
        quality -= 0.06
    if line_consensus_gap > 1.0:
        quality -= 0.03
    quality = max(0.75, min(1.0, quality))

    confidence = round(min(0.97, max(0.50, (raw_conf + context_shift) * cal * quality)), 4)
    edge = round(confidence - 0.5, 4)
    tier = "Strong" if edge >= 0.10 else "Moderate" if edge >= 0.05 else "Lean"

    # De-vig implied probs
    if over_odds and under_odds and over_odds > 1 and under_odds > 1:
        p_o = 1 / over_odds;  p_u = 1 / under_odds;  tot = p_o + p_u
        dv_over = round(p_o / tot, 4);  dv_under = round(p_u / tot, 4)
    else:
        dv_over = dv_under = 0.5

    # Uncertainty / reliability shaping
    stat_cv = abs(std) / max(abs(mean), 1.0)
    sample_unc = max(0.0, min(1.0, (8.0 - float(stats["n_games"])) / 8.0))
    vol_unc = max(0.0, min(1.0, stat_cv / 1.4))
    market_unc = max(0.0, min(1.0, line_consensus_gap / 2.0))
    role_unc = max(0.0, min(1.0, 1.0 - minutes_stability))
    uncertainty = max(0.0, min(1.0, 0.35 * sample_unc + 0.30 * vol_unc + 0.20 * market_unc + 0.15 * role_unc))

    confidence = round(max(0.50, min(0.97, confidence * (1.0 - 0.18 * uncertainty))), 4)
    edge = round(confidence - 0.5, 4)
    tier = "Strong" if edge >= 0.10 else "Moderate" if edge >= 0.05 else "Lean"

    market_prob_for_call = dv_over if call == "Over" else dv_under
    model_market_edge = round(confidence - market_prob_for_call, 4)
    expected_value_unit = round((confidence * ((over_odds if call == "Over" else under_odds) - 1) - (1 - confidence)), 4) if (over_odds and under_odds and over_odds > 1 and under_odds > 1) else None

    player_headshot = next((g.get("player_headshot") for g in games if g.get("player_headshot")), "")
    team_logo = next((g.get("team_logo") for g in games if g.get("team_logo")), "")
    athlete_id = _athlete_id_from_headshot(str(player_headshot or ""))
    season_overview = _fetch_player_season_overview(player_name, athlete_id)

    return {
        "player":          player_name,
        "market":          market,
        "market_label":    _market_label(market),
        "line":            line,
        "call":            call,
        "confidence":      confidence,
        "edge":            edge,
        "tier":            tier,
        "rolling_mean":    mean,
        "rolling_std":     round(std, 2),
        "last3_mean":      l3mean,
        "last5_mean":      l5mean,
        "last10_mean":     l10mean,
        "n_games":         stats["n_games"],
        "hit_rate_over":   round(hit_rate_over, 3),
        "hit_rate_under":  round(hit_rate_under, 3),
        "z_score":         round(z_score, 3),
        "over_odds":       over_odds,
        "under_odds":      under_odds,
        "dv_over_prob":    dv_over,
        "dv_under_prob":   dv_under,
        "market_prob_for_call": round(market_prob_for_call, 4),
        "model_market_edge": model_market_edge,
        "ev_per_unit": expected_value_unit,
        "data_source":     "ESPN box scores",
        "athlete_id":      athlete_id,
        "player_headshot": player_headshot,
        "team_logo": team_logo,
        "season_overview": season_overview,
        "recent_games": [
            {
                "date": g.get("date"),
                "opponent": g.get("opponent"),
                "team": g.get("team"),
                "PTS": g.get("PTS"),
                "REB": g.get("REB"),
                "AST": g.get("AST"),
                "3PT": g.get("3PT"),
                "FGA": g.get("FGA"),
                "3PA": g.get("3PA"),
                "STL": g.get("STL"),
                "BLK": g.get("BLK"),
                "MIN": g.get("MIN"),
                "player_headshot": g.get("player_headshot"),
            }
            for g in games[:10]
        ],
        "confidence_legend": [
            f"Base trend vs line: {'favoring Over' if weighted > 0 else 'favoring Under'} (avg {mean} | line {line})",
            f"Recent form (last 5): {l5mean} vs line {line}",
            f"Hit rate for {call}: {round((hit_rate_over if call == 'Over' else hit_rate_under) * 100, 1)}%",
            f"Momentum (latest vs prior games): {'up' if momentum_score > 0 else 'down' if momentum_score < 0 else 'flat'} ({round(momentum_raw, 2)} raw)",
            f"Usage trend (FGA): {'up' if usage_trend > 0 else 'down' if usage_trend < 0 else 'flat'} ({round(fga_recent,1)} vs {round(fga_prior,1)})",
            (
                f"Market side: {team_name or 'team'} is {market_side} (odds {round(float(team_odds), 2)} vs {opponent_name or 'opponent'} {round(float(opp_odds), 2)})"
                if team_odds and opp_odds
                else "Market side: unavailable (missing team-to-game odds mapping)"
            ),
            f"Matchup vs {player_pos_bucket}: opp allows {tm_ctx.get('opp_allowed_vs_pos', '—')} vs league {tm_ctx.get('league_pos_avg', '—')}",
            f"Pace proxy: team {tm_ctx.get('team_pace_proxy', '—')} vs league {tm_ctx.get('league_pace_proxy', '—')}",
            f"Rest/schedule: {days_rest} day rest, B2B={int(b2b)}, games last7={games_last7}",
            f"Starter reliability: {round(starter_prob * 100, 1)}% (minutes stability {round(minutes_stability * 100, 1)}%)",
            f"Market alignment (FD/DK line gap): {round(line_consensus_gap, 2)}",
            f"Model edge vs market: {round(model_market_edge * 100, 1)} pts ({round(confidence * 100, 1)}% vs market {round(market_prob_for_call * 100, 1)}%)",
            f"Uncertainty score: {round(uncertainty * 100, 1)}% (sample/volatility/line disagreement/role)",
            f"Minutes trend: last3 {round(avg_min_3, 1)} min vs last10 {round(avg_min_10, 1)} min ({'up' if minutes_trend > 0 else 'down' if minutes_trend < 0 else 'flat'})",
            f"Position injury context ({player_pos_bucket}): teammate injuries at this position {round(team_pos_injury * 100, 1)}% load",
            f"Context adjustment: {'+' if context_shift >= 0 else ''}{round(context_shift * 100, 1)} confidence points (quality x{round(quality,2)})",
        ],
        "confidence_legend_es": [
            f"Tendencia base vs linea: {'favorece Over' if weighted > 0 else 'favorece Under'} (promedio {mean} | linea {line})",
            f"Forma reciente (ultimos 5): {l5mean} vs linea {line}",
            f"Hit rate para {call}: {round((hit_rate_over if call == 'Over' else hit_rate_under) * 100, 1)}%",
            f"Momentum (juegos recientes vs previos): {'subiendo' if momentum_score > 0 else 'bajando' if momentum_score < 0 else 'estable'} ({round(momentum_raw, 2)} bruto)",
            f"Tendencia de uso (FGA): {'subiendo' if usage_trend > 0 else 'bajando' if usage_trend < 0 else 'estable'} ({round(fga_recent,1)} vs {round(fga_prior,1)})",
            (
                f"Lado de mercado: {team_name or 'equipo'} es {('underdog' if market_side == 'underdog' else 'favorito' if market_side == 'favorite' else 'parejo')} (cuotas {round(float(team_odds), 2)} vs {opponent_name or 'rival'} {round(float(opp_odds), 2)})"
                if team_odds and opp_odds
                else "Lado de mercado: no disponible (falta mapear cuotas del equipo)"
            ),
            f"Matchup vs {player_pos_bucket}: rival permite {tm_ctx.get('opp_allowed_vs_pos', '—')} vs liga {tm_ctx.get('league_pos_avg', '—')}",
            f"Ritmo (pace) proxy: equipo {tm_ctx.get('team_pace_proxy', '—')} vs liga {tm_ctx.get('league_pace_proxy', '—')}",
            f"Descanso/carga: {days_rest} dias descanso, B2B={int(b2b)}, juegos ult7={games_last7}",
            f"Confiabilidad de titular: {round(starter_prob * 100, 1)}% (estabilidad minutos {round(minutes_stability * 100, 1)}%)",
            f"Alineacion de mercado (gap linea FD/DK): {round(line_consensus_gap, 2)}",
            f"Edge del modelo vs mercado: {round(model_market_edge * 100, 1)} pts ({round(confidence * 100, 1)}% vs mercado {round(market_prob_for_call * 100, 1)}%)",
            f"Incertidumbre: {round(uncertainty * 100, 1)}% (muestra/volatilidad/desacuerdo de linea/rol)",
            f"Tendencia de minutos: ultimos3 {round(avg_min_3, 1)} min vs ultimos10 {round(avg_min_10, 1)} min ({'subiendo' if minutes_trend > 0 else 'bajando' if minutes_trend < 0 else 'estable'})",
            f"Contexto de lesion por posicion ({player_pos_bucket}): carga de lesiones de companeros en esa posicion {round(team_pos_injury * 100, 1)}%",
            f"Ajuste final de contexto: {'+' if context_shift >= 0 else ''}{round(context_shift * 100, 1)} puntos de confianza (calidad x{round(quality,2)})",
        ],
        "context": {
            "underdog_strength": round(underdog_strength, 3),
            "market_side": market_side,
            "team_injury_load": round(team_injury, 3),
            "opp_injury_load": round(opp_injury, 3),
            "team_pos_injury_load": round(team_pos_injury, 3),
            "game_importance": round(importance, 3),
            "context_shift": round(context_shift, 3),
            "team": team_name,
            "opponent": opponent_name,
            "team_odds": team_odds,
            "opp_odds": opp_odds,
            "player_pos": player_pos,
            "player_pos_bucket": player_pos_bucket,
            "avg_min_10": round(avg_min_10, 1),
            "avg_min_3": round(avg_min_3, 1),
            "minutes_trend": round(minutes_trend, 3),
            "momentum_raw": round(momentum_raw, 3),
            "momentum_score": round(momentum_score, 3),
            "usage_trend": round(usage_trend, 3),
            "fga_recent": round(fga_recent, 2),
            "fga_prior": round(fga_prior, 2),
            "defense_vs_pos_score": defense_vs_pos_score,
            "opp_allowed_vs_pos": tm_ctx.get("opp_allowed_vs_pos"),
            "pace_score": pace_score,
            "team_pace_proxy": tm_ctx.get("team_pace_proxy"),
            "league_pace_proxy": tm_ctx.get("league_pace_proxy"),
            "days_rest": days_rest,
            "is_b2b": int(b2b),
            "games_last7": games_last7,
            "starter_probability": round(starter_prob, 3),
            "minutes_stability": round(minutes_stability, 3),
            "line_consensus_gap": round(line_consensus_gap, 3),
            "market_alignment": round(market_alignment, 3),
            "quality_score": round(quality, 3),
            "uncertainty_score": round(uncertainty, 3),
            "model_market_edge": model_market_edge,
            "calibration_factor": round(cal, 3),
        },
    }


def prewarm_box_cache() -> None:
    """
    Pre-fetch all box scores for recent games into cache.
    Call this on startup in a background thread so the first
    /api/props/nba/ml-predictions request is fast.
    """
    try:
        game_ids = _fetch_recent_game_ids()
        logger.info("Pre-warming %d box scores...", len(game_ids))
        for gid in game_ids:
            if gid not in _BOX_CACHE:
                _fetch_box_score(gid)
                time.sleep(0.15)
        logger.info("Box score cache warm: %d games", len(_BOX_CACHE))
    except Exception as exc:
        logger.warning("Box prewarm failed: %s", exc)


def _market_label(market: str) -> str:
    return {
        "player_points":                  "Points",
        "player_rebounds":                "Rebounds",
        "player_assists":                 "Assists",
        "player_threes":                  "3-Pointers",
        "player_steals":                  "Steals",
        "player_blocks":                  "Blocks",
        "player_points_rebounds_assists": "Pts+Reb+Ast",
        "player_points_rebounds":         "Pts+Reb",
        "player_points_assists":          "Pts+Ast",
        "player_rebounds_assists":        "Reb+Ast",
    }.get(market, market)
