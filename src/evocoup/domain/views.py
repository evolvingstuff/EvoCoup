"""Explicit public, seat-private, and developer projections of game state."""

from copy import deepcopy
from dataclasses import dataclass

from evocoup.domain.decisions import DecisionRequest
from evocoup.domain.enums import ActionType, GamePhase, Role
from evocoup.domain.events import GameEvent
from evocoup.domain.models import GameState


@dataclass(frozen=True, slots=True)
class PrivateCardView:
    id: str
    role: Role


@dataclass(frozen=True, slots=True)
class PublicPlayerView:
    id: str
    name: str
    seat: int
    coins: int
    hidden_influence_count: int
    revealed_roles: tuple[Role, ...]
    is_alive: bool


@dataclass(frozen=True, slots=True)
class PendingActionView:
    actor_id: str
    action: ActionType
    target_id: str | None
    claimed_role: Role | None


@dataclass(frozen=True, slots=True)
class PendingBlockView:
    blocker_id: str
    claimed_role: Role


@dataclass(frozen=True, slots=True)
class PublicGameView:
    game_id: str
    version: int
    turn: int
    phase: GamePhase
    active_player_id: str
    starting_player_id: str
    players: tuple[PublicPlayerView, ...]
    court_deck_count: int
    treasury: int
    pending_action: PendingActionView | None
    pending_block: PendingBlockView | None
    winner_id: str | None
    history: tuple[GameEvent, ...]


@dataclass(frozen=True, slots=True)
class SeatGameView:
    public: PublicGameView
    player_id: str
    hidden_cards: tuple[PrivateCardView, ...]
    known_setup_discards: tuple[PrivateCardView, ...]
    setup_choices: tuple[PrivateCardView, ...]
    exchange_cards: tuple[PrivateCardView, ...]
    pending_decision: DecisionRequest | None


@dataclass(frozen=True, slots=True)
class DeveloperGameView:
    state: GameState
    pending_decision: DecisionRequest | None


def public_view(state: GameState) -> PublicGameView:
    pending_action = None
    if state.pending_action is not None:
        pending_action = PendingActionView(
            actor_id=state.pending_action.actor_id,
            action=state.pending_action.action,
            target_id=state.pending_action.target_id,
            claimed_role=state.pending_action.claimed_role,
        )
    pending_block = None
    if state.pending_block is not None:
        pending_block = PendingBlockView(
            blocker_id=state.pending_block.blocker_id,
            claimed_role=state.pending_block.claimed_role,
        )
    return PublicGameView(
        game_id=state.game_id,
        version=state.version,
        turn=state.turn,
        phase=state.phase,
        active_player_id=state.active_player_id,
        starting_player_id=state.starting_player_id,
        players=tuple(
            PublicPlayerView(
                id=player.id,
                name=player.name,
                seat=player.seat,
                coins=player.coins,
                hidden_influence_count=len(player.hidden_influences),
                revealed_roles=tuple(
                    influence.card.role for influence in player.revealed_influences
                ),
                is_alive=player.is_alive,
            )
            for player in state.players
        ),
        court_deck_count=len(state.court_deck),
        treasury=state.treasury,
        pending_action=pending_action,
        pending_block=pending_block,
        winner_id=state.winner_id,
        history=tuple(state.history),
    )


def seat_view(
    state: GameState,
    player_id: str,
    pending_decision: DecisionRequest | None,
) -> SeatGameView:
    player = state.player(player_id)
    own_decision = (
        pending_decision if pending_decision and pending_decision.player_id == player_id else None
    )
    exchange_cards = [influence.card for influence in player.hidden_influences]
    if state.phase is GamePhase.EXCHANGE and state.pending_action is not None:
        if state.pending_action.actor_id == player_id:
            exchange_cards.extend(state.exchange_drawn)
        else:
            exchange_cards = []
    else:
        exchange_cards = []
    return SeatGameView(
        public=public_view(state),
        player_id=player_id,
        hidden_cards=tuple(
            PrivateCardView(influence.card.id, influence.card.role)
            for influence in player.hidden_influences
        ),
        known_setup_discards=tuple(
            PrivateCardView(card.id, card.role) for card in state.out_of_play.get(player_id, [])
        ),
        setup_choices=tuple(
            PrivateCardView(card.id, card.role) for card in state.setup_options.get(player_id, [])
        ),
        exchange_cards=tuple(PrivateCardView(card.id, card.role) for card in exchange_cards),
        pending_decision=own_decision,
    )


def developer_view(
    state: GameState,
    pending_decision: DecisionRequest | None,
) -> DeveloperGameView:
    return DeveloperGameView(state=deepcopy(state), pending_decision=deepcopy(pending_decision))
