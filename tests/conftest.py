"""Test helpers for driving the public decision interface."""

from collections.abc import Callable

import pytest

from evocoup.domain.decisions import Decision, DecisionRequest, LegalOption
from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import DecisionKind, Role
from evocoup.domain.events import GameEvent
from evocoup.domain.models import Card


@pytest.fixture
def three_player_game() -> GameEngine:
    return GameEngine.new(["Ada", "Babbage", "Curie"], seed=7)


def choose(
    engine: GameEngine,
    option_id: str | None = None,
    *,
    where: Callable[[LegalOption], bool] | None = None,
) -> tuple[GameEvent, ...]:
    request = require_request(engine)
    if option_id is not None:
        option = next(option for option in request.options if option.id == option_id)
    elif where is not None:
        option = next(option for option in request.options if where(option))
    else:
        raise ValueError("choose requires option_id or where")
    decision = Decision(
        request_id=request.id,
        state_version=request.state_version,
        player_id=request.player_id,
        option_id=option.id,
    )
    return engine.apply_decision(decision)


def require_request(engine: GameEngine) -> DecisionRequest:
    request = engine.pending_decision()
    if request is None:
        raise AssertionError("expected a pending decision")
    return request


def pass_all(engine: GameEngine, kind: DecisionKind) -> None:
    while (request := engine.pending_decision()) is not None and request.kind is kind:
        choose(engine, where=lambda option: option.id.endswith(":pass"))


def set_coins(engine: GameEngine, player_id: str, coins: int) -> None:
    player = engine.state.player(player_id)
    difference = coins - player.coins
    if difference > engine.state.treasury:
        raise ValueError("test treasury does not contain enough coins")
    player.coins = coins
    engine.state.treasury -= difference


def set_hidden_roles(engine: GameEngine, player_id: str, roles: tuple[Role, Role]) -> None:
    """Swap cards between zones so a player's two hidden cards have known roles."""

    player = engine.state.player(player_id)
    if len(player.hidden_influences) != 2:
        raise ValueError("helper requires a player with two hidden influences")
    for slot, role in enumerate(roles):
        influence = player.hidden_influences[slot]
        if influence.card.role is role:
            continue
        replacement, replace = _find_card_source(engine, role, excluded=influence.card.id)
        old_card = influence.card
        influence.card = replacement
        replace(old_card)


def _find_card_source(
    engine: GameEngine,
    role: Role,
    *,
    excluded: str,
) -> tuple[Card, Callable[[Card], None]]:
    for index, card in enumerate(engine.state.court_deck):
        if card.role is role and card.id != excluded:
            return card, lambda replacement, index=index: engine.state.court_deck.__setitem__(
                index, replacement
            )
    for candidate in engine.state.players:
        for influence in candidate.hidden_influences:
            if influence.card.role is role and influence.card.id != excluded:
                return influence.card, lambda replacement, influence=influence: setattr(
                    influence, "card", replacement
                )
    raise AssertionError(f"could not find a {role.value} card to swap")
