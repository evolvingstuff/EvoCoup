"""Mutable aggregate state for a single game of Coup."""

from dataclasses import dataclass, field

from evocoup.domain.enums import (
    ActionType,
    ClaimKind,
    Continuation,
    GamePhase,
    Role,
)
from evocoup.domain.events import GameEvent


@dataclass(frozen=True, slots=True)
class Card:
    id: str
    role: Role


@dataclass(slots=True)
class Influence:
    card: Card
    revealed: bool = False


@dataclass(slots=True)
class PlayerState:
    id: str
    name: str
    seat: int
    coins: int
    influences: list[Influence] = field(default_factory=list)

    @property
    def hidden_influences(self) -> list[Influence]:
        return [influence for influence in self.influences if not influence.revealed]

    @property
    def revealed_influences(self) -> list[Influence]:
        return [influence for influence in self.influences if influence.revealed]

    @property
    def is_alive(self) -> bool:
        return bool(self.hidden_influences)

    def has_role(self, role: Role) -> bool:
        return any(influence.card.role is role for influence in self.hidden_influences)


@dataclass(slots=True)
class PendingAction:
    actor_id: str
    action: ActionType
    target_id: str | None
    claimed_role: Role | None
    paid_cost: int = 0


@dataclass(slots=True)
class PendingBlock:
    blocker_id: str
    claimed_role: Role


@dataclass(slots=True)
class PendingChallenge:
    claimant_id: str
    challenger_id: str
    role: Role
    claim_kind: ClaimKind


@dataclass(slots=True)
class PendingInfluenceLoss:
    player_id: str
    reason: str
    continuation: Continuation


@dataclass(slots=True)
class GameState:
    game_id: str
    seed: int | None
    players: list[PlayerState]
    court_deck: list[Card]
    treasury: int
    starting_player_id: str
    active_player_id: str
    phase: GamePhase
    turn: int = 1
    version: int = 0
    pending_action: PendingAction | None = None
    pending_block: PendingBlock | None = None
    pending_challenge: PendingChallenge | None = None
    pending_influence_loss: PendingInfluenceLoss | None = None
    response_queue: list[str] = field(default_factory=list)
    setup_options: dict[str, list[Card]] = field(default_factory=dict)
    setup_queue: list[str] = field(default_factory=list)
    out_of_play: dict[str, list[Card]] = field(default_factory=dict)
    exchange_drawn: list[Card] = field(default_factory=list)
    winner_id: str | None = None
    history: list[GameEvent] = field(default_factory=list)
    next_event_sequence: int = 1

    def player(self, player_id: str) -> PlayerState:
        for player in self.players:
            if player.id == player_id:
                return player
        raise KeyError(f"unknown player: {player_id}")

    @property
    def living_players(self) -> list[PlayerState]:
        return [player for player in self.players if player.is_alive]
