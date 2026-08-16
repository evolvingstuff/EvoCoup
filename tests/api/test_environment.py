from pathlib import Path

import pytest

from evocoup.api.environment import save_openai_api_key


def test_save_api_key_preserves_other_settings_and_replaces_existing_key(
    tmp_path: Path,
) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "# EvoCoup settings\n"
        "EVOCOUP_OPENAI_MODEL=test-model\n"
        "OPENAI_API_KEY=sk-old-key-that-is-long-enough\n",
        encoding="utf-8",
    )

    save_openai_api_key(env_path, "sk-new_key-that-is-long-enough")

    contents = env_path.read_text(encoding="utf-8")
    assert "# EvoCoup settings" in contents
    assert "EVOCOUP_OPENAI_MODEL=test-model" in contents
    assert "OPENAI_API_KEY=sk-new_key-that-is-long-enough" in contents
    assert "sk-old" not in contents
    assert env_path.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "api_key",
    ["short", "sk-has spaces and is long", "sk-has$a$dollar-sign"],
)
def test_save_api_key_rejects_unexpected_values(tmp_path: Path, api_key: str) -> None:
    env_path = tmp_path / ".env"

    with pytest.raises(ValueError, match="unexpected format"):
        save_openai_api_key(env_path, api_key)

    assert not env_path.exists()
