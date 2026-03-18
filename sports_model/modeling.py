from __future__ import annotations

import json
from typing import Callable

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    from xgboost import XGBClassifier  # type: ignore
except Exception:
    XGBClassifier = None

try:
    from lightgbm import LGBMClassifier  # type: ignore
except Exception:
    LGBMClassifier = None


def _calibrated_logreg() -> Pipeline:
    base = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
            ("clf", LogisticRegression(max_iter=2000, n_jobs=None)),
        ]
    )
    return Pipeline(steps=[("calibrated", CalibratedClassifierCV(estimator=base, method="sigmoid", cv=3))])


def _hist_gb() -> Pipeline:
    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("clf", HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, max_iter=250, random_state=42)),
        ]
    )


def _xgb() -> Pipeline:
    assert XGBClassifier is not None
    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            (
                "clf",
                XGBClassifier(
                    n_estimators=300,
                    max_depth=4,
                    learning_rate=0.05,
                    subsample=0.9,
                    colsample_bytree=0.9,
                    objective="binary:logistic",
                    eval_metric="logloss",
                    random_state=42,
                ),
            ),
        ]
    )


def _lgbm() -> Pipeline:
    assert LGBMClassifier is not None
    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            (
                "clf",
                LGBMClassifier(
                    n_estimators=400,
                    learning_rate=0.04,
                    num_leaves=31,
                    subsample=0.9,
                    colsample_bytree=0.9,
                    random_state=42,
                    objective="binary",
                ),
            ),
        ]
    )


def available_models() -> dict[str, Callable[[], Pipeline]]:
    models: dict[str, Callable[[], Pipeline]] = {
        "logreg_cal": _calibrated_logreg,
        "hist_gb": _hist_gb,
    }
    if XGBClassifier is not None:
        models["xgboost"] = _xgb
    if LGBMClassifier is not None:
        models["lightgbm"] = _lgbm
    return models


def walk_forward_validate_model(X: pd.DataFrame, y: pd.Series, model_builder: Callable[[], Pipeline], n_splits: int = 5) -> dict:
    tscv = TimeSeriesSplit(n_splits=n_splits)
    fold_metrics: list[dict] = []

    for fold_idx, (train_idx, test_idx) in enumerate(tscv.split(X), start=1):
        X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
        y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]

        model = model_builder()
        model.fit(X_train, y_train)
        p = model.predict_proba(X_test)[:, 1]

        fold = {
            "fold": fold_idx,
            "samples": int(len(test_idx)),
            "log_loss": float(log_loss(y_test, p, labels=[0, 1])),
            "brier": float(brier_score_loss(y_test, p)),
            "roc_auc": float(roc_auc_score(y_test, p)) if len(np.unique(y_test)) > 1 else None,
        }
        fold_metrics.append(fold)

    valid_auc = [m["roc_auc"] for m in fold_metrics if m["roc_auc"] is not None]
    return {
        "folds": fold_metrics,
        "avg_log_loss": float(np.mean([m["log_loss"] for m in fold_metrics])),
        "avg_brier": float(np.mean([m["brier"] for m in fold_metrics])),
        "avg_roc_auc": float(np.mean(valid_auc)) if valid_auc else None,
    }


def benchmark_models(X: pd.DataFrame, y: pd.Series, n_splits: int = 5) -> dict:
    registry = available_models()
    results: dict[str, dict] = {}

    for name, builder in registry.items():
        results[name] = walk_forward_validate_model(X, y, builder, n_splits=n_splits)

    ranking = sorted(
        [{"model": k, "avg_log_loss": v["avg_log_loss"], "avg_brier": v["avg_brier"]} for k, v in results.items()],
        key=lambda r: (r["avg_log_loss"], r["avg_brier"]),
    )
    best_model = ranking[0]["model"]

    return {
        "models": results,
        "ranking": ranking,
        "best_model": best_model,
    }


def oos_walk_forward_predictions(
    X: pd.DataFrame,
    y: pd.Series,
    model_name: str,
    n_splits: int = 5,
) -> np.ndarray:
    registry = available_models()
    if model_name not in registry:
        raise ValueError(f"Unknown model: {model_name}")

    tscv = TimeSeriesSplit(n_splits=n_splits)
    pred = np.full(shape=len(X), fill_value=np.nan, dtype=float)

    for train_idx, test_idx in tscv.split(X):
        X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
        y_train = y.iloc[train_idx]
        model = registry[model_name]()
        model.fit(X_train, y_train)
        pred[test_idx] = model.predict_proba(X_test)[:, 1]

    return pred


def train_final_model(X: pd.DataFrame, y: pd.Series, model_name: str) -> Pipeline:
    registry = available_models()
    if model_name not in registry:
        raise ValueError(f"Unknown model: {model_name}")
    model = registry[model_name]()
    model.fit(X, y)
    return model


def save_model(model: Pipeline, path: str) -> None:
    joblib.dump(model, path)


def save_metrics(metrics: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2)
