from dataclasses import dataclass
import os

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    api_football_key: str = os.getenv("API_FOOTBALL_KEY", "")
    sportradar_key: str = os.getenv("SPORTRADAR_KEY", "")
    stats_perform_key: str = os.getenv("STATS_PERFORM_KEY", "")
    the_odds_api_key: str = os.getenv("THE_ODDS_API_KEY", "")
    news_api_key: str = os.getenv("NEWS_API_KEY", "")
    openweather_api_key: str = os.getenv("OPENWEATHER_API_KEY", "")
    reddit_client_id: str = os.getenv("REDDIT_CLIENT_ID", "")
    reddit_client_secret: str = os.getenv("REDDIT_CLIENT_SECRET", "")
    reddit_user_agent: str = os.getenv("REDDIT_USER_AGENT", "sports-model/1.0")

    odds_region: str = os.getenv("ODDS_REGION", "us")
    odds_market: str = os.getenv("ODDS_MARKET", "h2h")

    bankroll_start: float = float(os.getenv("BANKROLL_START", "10000"))
    kelly_fraction: float = float(os.getenv("KELLY_FRACTION", "0.25"))
    max_bet_pct: float = float(os.getenv("MAX_BET_PCT", "0.02"))
    min_edge: float = float(os.getenv("MIN_EDGE", "0.03"))


settings = Settings()
