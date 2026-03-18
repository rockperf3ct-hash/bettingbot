from __future__ import annotations

import pandas as pd


def derive_open_mid_close(lines: pd.DataFrame) -> pd.DataFrame:
    if lines.empty:
        return pd.DataFrame(
            columns=[
                "event_id",
                "home_team",
                "away_team",
                "commence_time",
                "home_odds_open",
                "away_odds_open",
                "home_odds_mid",
                "away_odds_mid",
                "home_odds_close",
                "away_odds_close",
            ]
        )

    work = lines.copy()
    work["captured_at"] = pd.to_datetime(work["captured_at"], utc=True)

    h2h = work[work["market"] == "h2h"].copy()
    if h2h.empty:
        return pd.DataFrame()

    pivoted = (
        h2h.pivot_table(
            index=["captured_at", "event_id", "home_team", "away_team", "commence_time", "bookmaker"],
            columns="outcome_name",
            values="price",
            aggfunc="first",
        )
        .reset_index()
        .rename_axis(None, axis=1)
    )

    if "home_team" not in pivoted.columns or "away_team" not in pivoted.columns:
        return pd.DataFrame()

    def _pick_side(df: pd.DataFrame, side_col: str) -> pd.Series:
        def pick_row(row: pd.Series):
            name = row.get(side_col)
            if name in row.index:
                return row.get(name)
            return None

        return df.apply(pick_row, axis=1)

    if "home_odds" not in pivoted.columns:
        pivoted["home_odds"] = _pick_side(pivoted, "home_team")
    if "away_odds" not in pivoted.columns:
        pivoted["away_odds"] = _pick_side(pivoted, "away_team")

    pivoted = pivoted[pivoted["home_odds"].notna() & pivoted["away_odds"].notna()].copy()

    grouped = []
    for event_id, g in pivoted.sort_values("captured_at").groupby("event_id"):
        g = g.sort_values("captured_at")
        mid_idx = len(g) // 2
        grouped.append(
            {
                "event_id": event_id,
                "home_team": g["home_team"].iloc[-1],
                "away_team": g["away_team"].iloc[-1],
                "commence_time": g["commence_time"].iloc[-1],
                "home_odds_open": float(g["home_odds"].iloc[0]),
                "away_odds_open": float(g["away_odds"].iloc[0]),
                "home_odds_mid": float(g["home_odds"].iloc[mid_idx]),
                "away_odds_mid": float(g["away_odds"].iloc[mid_idx]),
                "home_odds_close": float(g["home_odds"].iloc[-1]),
                "away_odds_close": float(g["away_odds"].iloc[-1]),
            }
        )

    return pd.DataFrame(grouped)


def attach_closing_odds(games: pd.DataFrame, line_summary: pd.DataFrame) -> pd.DataFrame:
    if line_summary.empty:
        out = games.copy()
        if "closing_home_odds" not in out.columns:
            out["closing_home_odds"] = out["home_odds"]
        if "closing_away_odds" not in out.columns:
            out["closing_away_odds"] = out["away_odds"]
        return out

    cols = [
        "home_team",
        "away_team",
        "home_odds_close",
        "away_odds_close",
    ]
    merged = games.merge(line_summary[cols], on=["home_team", "away_team"], how="left")
    merged["closing_home_odds"] = merged["home_odds_close"].fillna(merged["home_odds"])
    merged["closing_away_odds"] = merged["away_odds_close"].fillna(merged["away_odds"])
    return merged.drop(columns=["home_odds_close", "away_odds_close"], errors="ignore")
