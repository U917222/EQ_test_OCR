"""Runtime configuration for the scoring API."""

from __future__ import annotations

import os
from dataclasses import dataclass


DEFAULT_SPREADSHEET_ID = "102G-XV6OXrNzTmXa96IWwcJcXZJ6A_vSEOQVIZ-7Z7U"


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    scoring_api_secret: str
    scoring_spreadsheet_id: str
    allow_insecure_dev_auth: bool

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            # Temporary fallback keeps rolling deployments compatible with the old name.
            scoring_api_secret=(
                os.environ.get("SCORING_API_SECRET")
                or os.environ.get("FUNCTIONS_GAS_SECRET", "")
            ),
            scoring_spreadsheet_id=os.environ.get(
                "SCORING_SPREADSHEET_ID", DEFAULT_SPREADSHEET_ID
            ),
            allow_insecure_dev_auth=env_flag("ALLOW_INSECURE_DEV_AUTH"),
        )
