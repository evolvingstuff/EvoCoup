"""Safe persistence for the local, git-ignored environment file."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

OPENAI_KEY_LINE = re.compile(r"^\s*(?:export\s+)?OPENAI_API_KEY\s*=")
OPENAI_KEY_VALUE = re.compile(r"^[A-Za-z0-9_-]{20,}$")


def save_openai_api_key(env_path: Path, api_key: str) -> None:
    """Atomically add or replace OPENAI_API_KEY with owner-only permissions."""

    if not OPENAI_KEY_VALUE.fullmatch(api_key):
        raise ValueError("the API key has an unexpected format")

    existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    lines = existing.splitlines()
    replacement = f"OPENAI_API_KEY={api_key}"
    output: list[str] = []
    replaced = False
    for line in lines:
        if OPENAI_KEY_LINE.match(line):
            if not replaced:
                output.append(replacement)
                replaced = True
            continue
        output.append(line)
    if not replaced:
        output.append(replacement)

    env_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".env.", dir=env_path.parent, text=True)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary_file:
            temporary_file.write("\n".join(output).rstrip("\n") + "\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        temporary_path.replace(env_path)
    finally:
        temporary_path.unlink(missing_ok=True)
