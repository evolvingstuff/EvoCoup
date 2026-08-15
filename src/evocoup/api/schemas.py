"""Validated HTTP request schemas."""

from typing import Literal

from pydantic import BaseModel, Field

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
