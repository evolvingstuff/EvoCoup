from dataclasses import asdict

import pytest
from conftest import choose, require_request

from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import DecisionKind, GamePhase, Role
from evocoup.domain.invariants import assert_valid_state


@pytest.mark.parametrize("player_count", range(3, 7))
def test_normal_setup_supports_three_through_six_players(player_count: int) -> None:
    engine = GameEngine.new([f"Player {index}" for index in range(player_count)], seed=42)

    assert engine.state.phase is GamePhase.AWAIT_ACTION
    assert len(engine.state.court_deck) == 15 - (2 * player_count)
    assert engine.state.treasury == 50 - (2 * player_count)
    assert all(len(player.hidden_influences) == 2 for player in engine.state.players)
    assert all(player.coins == 2 for player in engine.state.players)
    assert_valid_state(engine.state)


def test_two_player_published_variant_preserves_asymmetric_setup_knowledge() -> None:
    engine = GameEngine.new(["Ada", "Babbage"], seed=3)
    first_request = require_request(engine)
    first_player_id = first_request.player_id
    second_player_id = next(
        player.id for player in engine.state.players if player.id != first_player_id
    )

    assert first_request.kind is DecisionKind.SETUP_CARD
    assert len(first_request.options) == 5
    assert len(engine.seat_view(first_player_id).setup_choices) == 5
    assert len(engine.seat_view(second_player_id).setup_choices) == 5

    chosen_role = first_request.options[0].data["role"]
    choose(engine, first_request.options[0].id)

    first_view = engine.seat_view(first_player_id)
    second_view = engine.seat_view(second_player_id)
    assert len(first_view.known_setup_discards) == 4
    assert {card.role for card in first_view.known_setup_discards} == set(Role) - {
        Role(chosen_role)
    }
    assert second_view.known_setup_discards == ()

    second_request = require_request(engine)
    choose(engine, second_request.options[0].id)

    assert engine.state.phase is GamePhase.AWAIT_ACTION
    assert len(engine.state.court_deck) == 3
    assert all(len(player.hidden_influences) == 2 for player in engine.state.players)
    assert sorted(player.coins for player in engine.state.players) == [1, 2]
    assert all(len(cards) == 4 for cards in engine.state.out_of_play.values())
    assert_valid_state(engine.state)


def test_public_and_seat_views_do_not_leak_opponent_cards() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=19)
    viewer = engine.state.players[0]
    opponent = engine.state.players[1]
    public_data = asdict(engine.public_view())
    seat_data = asdict(engine.seat_view(viewer.id))

    opponent_card_ids = {influence.card.id for influence in opponent.hidden_influences}
    opponent_roles = {influence.card.role.value for influence in opponent.hidden_influences}
    public_text = repr(public_data)
    seat_text = repr(seat_data)

    assert all(card_id not in public_text for card_id in opponent_card_ids)
    assert all(card_id not in seat_text for card_id in opponent_card_ids)
    assert all(card.role in Role for card in engine.seat_view(viewer.id).hidden_cards)
    # Roles can occur elsewhere in public history, so secrecy is keyed by unique card ID.
    assert opponent_roles


def test_developer_view_is_a_defensive_copy() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=2)
    debug = engine.developer_view()
    debug.state.players[0].coins = 99

    assert engine.state.players[0].coins == 2
