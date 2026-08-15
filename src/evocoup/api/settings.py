"""Environment-backed local application settings."""

from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: SecretStr | None = Field(default=None, alias="OPENAI_API_KEY")
    openai_model: str = Field(default="gpt-5.6-terra", alias="EVOCOUP_OPENAI_MODEL")
    reasoning_effort: Literal["none", "low", "medium", "high", "xhigh"] = Field(
        default="low",
        alias="EVOCOUP_REASONING_EFFORT",
    )
    openai_timeout_seconds: float = Field(
        default=90,
        gt=0,
        alias="EVOCOUP_OPENAI_TIMEOUT_SECONDS",
    )
