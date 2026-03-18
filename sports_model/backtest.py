from __future__ import annotations

# pyright: reportArgumentType=false, reportAttributeAccessIssue=false

import json
from typing import Any, cast

import numpy as np
import pandas as pd


def devig_two_way(home_odds: float, away_odds: float) -> tuple[float, float]:
    p_home_raw = 1.0 / home_odds
    p_away_raw = 1.0 / away_odds
    total = p_home_raw + p_away_raw
    return p_home_raw / total, p_away_raw / total


def kelly_fraction_decimal_odds(prob: float, odds: float) -> float:
    b = odds - 1.0
    if b <= 0:
        return 0.0
    f = (b * prob - (1 - prob)) / b
    return max(0.0, f)


def run_backtest(
    meta: pd.DataFrame,
    pred_home_win_prob: np.ndarray,
    bankroll_start: float,
    min_edge: float,
    kelly_fraction_scale: float,
    max_bet_pct: float,
) -> tuple[pd.DataFrame, dict]:
    df = meta.copy().reset_index(drop=True)
    df["pred_home_win_prob"] = pred_home_win_prob

    bankroll = bankroll_start
    records = []
    simulated_odds_count = 0

    for row in df.itertuples(index=False):
        home_odds = float(cast(Any, row.home_odds))  # pyright: ignore[reportArgumentType]
        away_odds = float(cast(Any, row.away_odds))  # pyright: ignore[reportArgumentType]
        p_home = float(cast(Any, row.pred_home_win_prob))  # pyright: ignore[reportArgumentType]
        p_away = 1.0 - p_home

        # If odds are placeholder (exact 2.0/2.0), use a flat vig market baseline.
        # Flag these rows so the backtest summary notes they are simulated.
        using_simulated_odds = abs(home_odds - 2.0) < 1e-6 and abs(away_odds - 2.0) < 1e-6
        if using_simulated_odds:
            simulated_odds_count += 1
            home_odds = 1.0 / 0.475   # 5% vig, 50/50 prior
            away_odds = 1.0 / 0.475

        mkt_home, mkt_away = devig_two_way(home_odds, away_odds)
        edge_home = p_home - mkt_home
        edge_away = p_away - mkt_away

        side = None
        edge = 0.0
        odds = 0.0
        prob = 0.0

        if edge_home >= min_edge and edge_home >= edge_away:
            side = "home"
            edge = edge_home
            odds = home_odds
            prob = p_home
        elif edge_away >= min_edge:
            side = "away"
            edge = edge_away
            odds = away_odds
            prob = p_away

        stake = 0.0
        pnl = 0.0
        won = None

        if side is not None and bankroll > 0:
            full_kelly = kelly_fraction_decimal_odds(prob, odds)
            # For simulated-odds games, cap stakes at 0.5% flat to avoid
            # explosive compounding against an artificial baseline
            effective_max = 0.005 if using_simulated_odds else max_bet_pct
            bet_frac = min(effective_max, kelly_fraction_scale * full_kelly)
            stake = bankroll * bet_frac

            home_win = int(float(cast(Any, row.home_score)) > float(cast(Any, row.away_score)))
            won = bool(home_win == 1) if side == "home" else bool(home_win == 0)
            if won:
                pnl = stake * (odds - 1.0)
            else:
                pnl = -stake

            bankroll += pnl

        closing_odds = None
        clv_pct = None
        closing_home_odds = getattr(row, "closing_home_odds", None)
        closing_away_odds = getattr(row, "closing_away_odds", None)

        if side == "home" and closing_home_odds is not None and pd.notna(closing_home_odds):
            closing_odds = float(cast(Any, closing_home_odds))  # pyright: ignore[reportArgumentType]
            if odds > 0 and closing_odds > 0:
                clv_pct = (odds / closing_odds) - 1.0
        elif side == "away" and closing_away_odds is not None and pd.notna(closing_away_odds):
            closing_odds = float(cast(Any, closing_away_odds))  # pyright: ignore[reportArgumentType]
            if odds > 0 and closing_odds > 0:
                clv_pct = (odds / closing_odds) - 1.0

        records.append(
            {
                "date": row.date,
                "league": row.league,
                "home_team": row.home_team,
                "away_team": row.away_team,
                "bet_side": side,
                "edge": edge,
                "stake": stake,
                "odds": odds,
                "won": won,
                "pnl": pnl,
                "bankroll": bankroll,
                "closing_odds": closing_odds,
                "clv_pct": clv_pct,
            }
        )

    bets = pd.DataFrame(records)
    placed = bets[bets["bet_side"].notna()].copy()

    if len(placed) == 0:
        summary = {
            "bets_placed": 0,
            "roi": 0.0,
            "yield": 0.0,
            "ending_bankroll": bankroll,
            "max_drawdown": 0.0,
            "hit_rate": 0.0,
        }
        return bets, summary

    stake_series = pd.Series(placed["stake"], dtype=float)
    pnl_series = pd.Series(placed["pnl"], dtype=float)
    won_series = pd.Series(placed["won"], dtype=float)
    bankroll_series = pd.Series(placed["bankroll"], dtype=float)

    total_staked = float(stake_series.sum())
    total_pnl = float(pnl_series.sum())
    roi = total_pnl / bankroll_start if bankroll_start else 0.0
    yld = total_pnl / total_staked if total_staked else 0.0
    hit_rate = float(won_series.mean())

    equity = bankroll_series.to_numpy(dtype=float)  # pyright: ignore[reportAttributeAccessIssue]
    running_max = np.maximum.accumulate(equity)
    drawdowns = (equity - running_max) / running_max
    max_drawdown = float(drawdowns.min()) if len(drawdowns) else 0.0

    summary = {
        "bets_placed": int(len(placed)),
        "roi": float(roi),
        "yield": float(yld),
        "ending_bankroll": float(bankroll_series.iloc[-1]),  # pyright: ignore[reportAttributeAccessIssue]
        "max_drawdown": max_drawdown,
        "hit_rate": hit_rate,
        "avg_clv_pct": float(placed["clv_pct"].dropna().mean()) if "clv_pct" in placed.columns else 0.0,
        "simulated_odds_games": simulated_odds_count,
        "real_odds_games": len(df) - simulated_odds_count,
        "odds_note": (
            "Backtest uses simulated 5%-vig baseline for games without real odds. "
            "Stake capped at 0.5% for simulated games. "
            "Get real historical odds via The Odds API paid tier for accurate CLV tracking."
        ) if simulated_odds_count > 0 else "All games used real market odds.",
    }

    return bets, summary


def save_backtest_summary(summary: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
