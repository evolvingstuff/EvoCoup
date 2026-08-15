"""Commands exchanged between the rules engine and decision providers."""

from dataclasses import dataclass, field
from typing import Any

from evocoup.domain.enums import DecisionKind


@dataclass(frozen=True, slots=True)
class LegalOption:
    """One opaque, engine-generated choice for a pending decision."""

    id: str
    label: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DecisionRequest:
    """The single decision currently required to advance the game."""

    id: str
    state_version: int
    player_id: str
    kind: DecisionKind
    prompt: str
    options: tuple[LegalOption, ...]


@dataclass(frozen=True, slots=True)
class Decision:
    """A player's selection from a DecisionRequest."""

    request_id: str
    state_version: int
    player_id: str
    option_id: str


class DecisionError(ValueError):
    """Raised when a decision is stale, ineligible, or illegal."""
