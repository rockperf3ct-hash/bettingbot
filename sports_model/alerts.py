"""
Discord webhook alerts for strong daily picks.

Usage:
  Set DISCORD_WEBHOOK_URL in .env
  Called automatically by daily_pipeline.py after recommendations are built.
  Can also be called manually: python -c "from sports_model.alerts import send_picks_alert; send_picks_alert()"
"""
from __future__ import annotations

import logging
import os
from datetime import date

import requests
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
MIN_TIER_TO_ALERT = {"Strong", "Moderate"}


def _tier_emoji(tier: str) -> str:
    return {"Strong": "🔥", "Moderate": "✅", "Lean": "🔹"}.get(tier, "🎯")


def _sport_emoji(sport: str) -> str:
    return {"soccer": "⚽", "nba": "🏀", "mlb": "⚾"}.get(sport, "🎯")


def format_picks_message(picks: list[dict], parlay: dict | None, today: str) -> dict:
    """Format picks as a Discord embed payload."""
    if not picks:
        return {
            "embeds": [{
                "title": f"🎯 AI Picks — {today}",
                "description": "No picks with sufficient edge found for today's slate.",
                "color": 0x374151,
            }]
        }

    lines = []
    for p in picks:
        emoji = _tier_emoji(p["tier"])
        sport = _sport_emoji(p["sport"])
        lines.append(
            f"{emoji} {sport} **{p['bet_team']}** ({p['bet_side'].upper()})  "
            f"`{p['edge']*100:.1f}% edge` · odds {p['odds']} · {p['tier']}\n"
            f"   {p['home_team']} vs {p['away_team']} — {p['league']}"
        )

    parlay_text = ""
    if parlay and parlay.get("legs"):
        legs = " + ".join(f"**{l['team']}** ({l['odds']})" for l in parlay["legs"])
        parlay_text = f"\n\n**💰 Parlay:** {legs}\nCombined: **{parlay['combined_odds']}x**"

    strong_count = sum(1 for p in picks if p["tier"] == "Strong")
    color = 0x22c55e if strong_count >= 2 else 0xeab308 if strong_count == 1 else 0x6b7280

    return {
        "embeds": [{
            "title": f"🎯 AI Picks — {today}",
            "description": "\n\n".join(lines) + parlay_text,
            "color": color,
            "footer": {
                "text": (
                    f"{len(picks)} picks found · "
                    "Edge = model prob minus market implied · "
                    "Bet responsibly 18+"
                )
            },
        }]
    }


def send_discord(payload: dict, webhook_url: str = "") -> bool:
    """POST payload to Discord webhook. Returns True on success."""
    url = webhook_url or DISCORD_WEBHOOK_URL
    if not url:
        logger.warning("DISCORD_WEBHOOK_URL not set — skipping Discord alert")
        return False
    try:
        r = requests.post(url, json=payload, timeout=10)
        r.raise_for_status()
        logger.info("Discord alert sent")
        return True
    except Exception as exc:
        logger.error("Discord alert failed: %s", exc)
        return False


def send_picks_alert(top_n: int = 8, webhook_url: str = "") -> bool:
    """
    Full pipeline: score today's games → format → send to Discord.
    Only sends picks that are Strong or Moderate tier.
    """
    try:
        from sports_model.recommendations import build_recommendations
        result = build_recommendations(top_n=top_n)
        today = result.get("date", date.today().isoformat())
        picks = [p for p in result.get("picks", []) if p["tier"] in MIN_TIER_TO_ALERT]
        parlay = result.get("parlay")
        payload = format_picks_message(picks, parlay, today)
        return send_discord(payload, webhook_url)
    except Exception as exc:
        logger.error("send_picks_alert failed: %s", exc)
        return False
