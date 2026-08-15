"""State invariants shared by production assertions and property tests."""

from collections import Counter

from evocoup.domain.enums import ActionType, GamePhase, Role
from evocoup.domain.models import Card, GameState


class InvariantError(AssertionError):
    """Raised when the engine has produced an impossible game state."""


def assert_valid_state(state: GameState) -> None:
    """Raise InvariantError when a game-state invariant is violated."""

    _require(2 <= len(state.players) <= 6, "player count must be between 2 and 6")
    player_ids = [player.id for player in state.players]
    _require(len(player_ids) == len(set(player_ids)), "player IDs must be unique")
    _require(state.active_player_id in player_ids, "active player must exist")
    _require(state.starting_player_id in player_ids, "starting player must exist")
    _require(state.treasury >= 0, "treasury cannot be negative")
    _require(state.version >= 0, "state version cannot be negative")

    all_cards = _cards_in_all_zones(state)
    card_ids = [card.id for card in all_cards]
    _require(len(all_cards) == 15, f"expected 15 cards across all zones, got {len(all_cards)}")
    _require(len(card_ids) == len(set(card_ids)), "card IDs must be unique across all zones")
    role_counts = Counter(card.role for card in all_cards)
    _require(
        role_counts == Counter({role: 3 for role in Role}),
        f"expected three cards of each role, got {role_counts}",
    )

    total_coins = state.treasury + sum(player.coins for player in state.players)
    _require(total_coins == 50, f"expected 50 coins across all zones, got {total_coins}")

    for index, player in enumerate(state.players):
        _require(player.seat == index, "player seats must be contiguous and ordered")
        _require(player.coins >= 0, f"{player.id} has negative coins")
        _require(len(player.influences) <= 2, f"{player.id} has more than two influences")
        if state.phase is not GamePhase.SETUP_SELECTION:
            _require(len(player.influences) == 2, f"{player.id} must have exactly two influences")
        if player.influences and not player.is_alive:
            _require(player.coins == 0, f"eliminated player {player.id} must return all coins")

    _assert_phase_shape(state)


def _cards_in_all_zones(state: GameState) -> list[Card]:
    cards = list(state.court_deck)
    cards.extend(influence.card for player in state.players for influence in player.influences)
    cards.extend(
        card for cards_for_player in state.out_of_play.values() for card in cards_for_player
    )
    cards.extend(card for options in state.setup_options.values() for card in options)
    cards.extend(state.exchange_drawn)
    return cards


def _assert_phase_shape(state: GameState) -> None:
    phase = state.phase
    if phase is GamePhase.SETUP_SELECTION:
        _require(bool(state.setup_queue), "setup phase requires a setup queue")
        _require(state.setup_queue[0] in state.setup_options, "setup player requires options")
        _require(state.pending_action is None, "setup cannot have a pending action")
        return

    _require(not state.setup_queue, "completed setup cannot retain a setup queue")
    _require(not state.setup_options, "completed setup cannot retain setup options")
    living = state.living_players
    _require(bool(living), "a started game must have a living player")

    if phase is GamePhase.AWAIT_ACTION:
        _require(state.player(state.active_player_id).is_alive, "active player must be alive")
        _require(state.pending_action is None, "action phase cannot retain a pending action")
    elif phase is GamePhase.ACTION_CHALLENGE:
        action = state.pending_action
        _require(action is not None, "action challenge requires an action")
        assert action is not None
        _require(action.claimed_role is not None, "challenged action needs a role")
        _require(bool(state.response_queue), "action challenge requires responders")
    elif phase is GamePhase.BLOCK_WINDOW:
        _require(state.pending_action is not None, "block window requires an action")
        _require(bool(state.response_queue), "block window requires responders")
    elif phase is GamePhase.BLOCK_CHALLENGE:
        _require(state.pending_action is not None, "block challenge requires an action")
        _require(state.pending_block is not None, "block challenge requires a block")
        _require(bool(state.response_queue), "block challenge requires responders")
    elif phase is GamePhase.CLAIM_RESPONSE:
        _require(state.pending_challenge is not None, "claim response requires a challenge")
    elif phase is GamePhase.INFLUENCE_LOSS:
        pending_loss = state.pending_influence_loss
        _require(pending_loss is not None, "influence loss requires context")
        assert pending_loss is not None
        loser = state.player(pending_loss.player_id)
        _require(bool(loser.hidden_influences), "influence loser must have a card to reveal")
    elif phase is GamePhase.EXCHANGE:
        action = state.pending_action
        _require(action is not None, "exchange requires a pending action")
        assert action is not None
        _require(action.action is ActionType.EXCHANGE, "exchange action mismatch")
        _require(len(state.exchange_drawn) == 2, "exchange must draw exactly two cards")
    elif phase is GamePhase.FINISHED:
        _require(len(living) == 1, "finished game must have exactly one living player")
        _require(state.winner_id == living[0].id, "winner must be the final living player")
        _require(state.pending_action is None, "finished game cannot have a pending action")
        _require(not state.response_queue, "finished game cannot have responders")
    else:
        raise InvariantError(f"unhandled phase: {phase}")

    for responder_id in state.response_queue:
        _require(responder_id in {player.id for player in living}, "responder must be alive")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise InvariantError(message)
