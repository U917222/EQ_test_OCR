"""Runtime configuration for the scoring API."""

from __future__ import annotations

import os


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}
