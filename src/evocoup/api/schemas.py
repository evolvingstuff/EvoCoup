"""Validated HTTP request schemas."""

from typing import Literal

from pydantic import BaseModel, Field, SecretStr, field_validator

from evocoup.api.environment import OPENAI_KEY_VALUE
from evocoup.application.match import MatchMode


class CreateGameRequest(BaseModel):
    player_count: int = Field(ge=2, le=6)
    mode: MatchMode
    seed: int | None = None


class SubmitDecisionRequest(BaseModel):
    request_id: str
    state_version: int = Field(ge=0)
    player_id: str
    option_id: str


class ControlRequest(BaseModel):
    action: Literal["step", "play"]


class ConfigureOpenAIRequest(BaseModel):
    api_key: SecretStr = Field(min_length=20)

    @field_validator("api_key", mode="before")
    @classmethod
    def validate_api_key(cls, value: object) -> object:
        if not isinstance(value, str) or not OPENAI_KEY_VALUE.fullmatch(value):
            raise ValueError("enter a valid OpenAI API key beginning with sk-")
        return value
