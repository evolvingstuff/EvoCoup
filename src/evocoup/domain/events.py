"""Typed, transient events emitted by accepted game decisions."""

from dataclasses import dataclass, field
from typing import Any

from evocoup.domain.enums import EventType


@dataclass(frozen=True, slots=True)
class GameEvent:
    sequence: int
    turn: int
    type: EventType
    message: str
    actor_id: str | None = None
    target_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
    public: bool = True
    private_to: str | None = None
