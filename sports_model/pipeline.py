from __future__ import annotations

import os
from typing import cast

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


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def full_run(data_path: str, out_dir: str) -> dict:
    ensure_dir(out_dir)

    raw = pd.read_csv(data_path)
    X_raw, y_raw, meta_raw = build_features(raw)
    X = cast(pd.DataFrame, X_raw)
    y = cast(pd.Series, y_raw)
    meta = cast(pd.DataFrame, meta_raw)

    benchmark = benchmark_models(X, y, n_splits=5)
    best_model = benchmark["best_model"]
    metrics = benchmark["models"][best_model]
    oos_pred = oos_walk_forward_predictions(X, y, model_name=best_model, n_splits=5)

    model = train_final_model(X, y, model_name=best_model)

    valid_mask = pd.Series(oos_pred).notna().to_numpy()
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

    save_model(model, os.path.join(out_dir, "model.joblib"))
    save_metrics(metrics, os.path.join(out_dir, "metrics.json"))
    save_metrics(benchmark, os.path.join(out_dir, "model_benchmark.json"))
    bets.to_csv(os.path.join(out_dir, "backtest_bets.csv"), index=False)
    save_backtest_summary(summary, os.path.join(out_dir, "backtest_summary.json"))

    return {
        "metrics": metrics,
        "best_model": best_model,
        "backtest_summary": summary,
        "output_dir": out_dir,
    }
