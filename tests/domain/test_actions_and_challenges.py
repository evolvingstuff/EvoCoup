from conftest import choose, pass_all, require_request, set_coins, set_hidden_roles

from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import DecisionKind, EventType, GamePhase, Role
from evocoup.domain.invariants import assert_valid_state


def test_income_moves_one_coin_from_treasury_and_advances_turn() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=7)
    actor = engine.state.player(engine.state.active_player_id)
    treasury_before = engine.state.treasury

    events = choose(engine, "action:income")

    assert actor.coins == 3
    assert engine.state.treasury == treasury_before - 1
    assert engine.state.turn == 2
    assert engine.state.active_player_id != actor.id
    assert any(event.type is EventType.ACTION_RESOLVED for event in events)


def test_ten_coins_forces_coup_and_coup_costs_seven() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=8)
    actor = engine.state.player(engine.state.active_player_id)
    target = next(player for player in engine.state.players if player.id != actor.id)
    set_coins(engine, actor.id, 10)
    request = require_request(engine)

    assert request.options
    assert all(option.id.startswith("action:coup:") for option in request.options)

    choose(engine, f"action:coup:{target.id}")
    assert actor.coins == 3
    assert require_request(engine).kind is DecisionKind.LOSE_INFLUENCE
    choose(engine, require_request(engine).options[0].id)

    assert len(target.hidden_influences) == 1
    assert engine.state.turn == 2
    assert_valid_state(engine.state)


def test_truthful_action_claim_replaces_card_and_penalizes_challenger() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=9)
    actor = engine.state.player(engine.state.active_player_id)
    set_hidden_roles(engine, actor.id, (Role.DUKE, Role.CAPTAIN))
    duke_id = next(
        influence.card.id
        for influence in actor.hidden_influences
        if influence.card.role is Role.DUKE
    )

    choose(engine, "action:tax")
    challenge_request = require_request(engine)
    challenger = engine.state.player(challenge_request.player_id)
    choose(engine, "action-challenge:challenge")
    assert {option.id for option in require_request(engine).options} == {
        "claim:prove",
        "claim:concede",
    }
    choose(engine, "claim:prove")
    choose(engine, require_request(engine).options[0].id)

    assert len(challenger.hidden_influences) == 1
    assert all(influence.card.id != duke_id for influence in actor.hidden_influences)
    assert actor.coins == 5
    assert engine.state.phase is GamePhase.AWAIT_ACTION
    assert_valid_state(engine.state)


def test_caught_assassin_bluff_refunds_cost_and_cancels_action() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=10)
    actor = engine.state.player(engine.state.active_player_id)
    target = next(player for player in engine.state.players if player.id != actor.id)
    set_hidden_roles(engine, actor.id, (Role.DUKE, Role.CAPTAIN))
    set_coins(engine, actor.id, 3)
    treasury_before = engine.state.treasury

    choose(engine, f"action:assassinate:{target.id}")
    assert actor.coins == 0
    choose(engine, "action-challenge:challenge")
    assert [option.id for option in require_request(engine).options] == ["claim:concede"]
    events = choose(engine, "claim:concede")
    assert actor.coins == 3
    assert engine.state.treasury == treasury_before
    assert any(event.type is EventType.COST_REFUNDED for event in events)
    choose(engine, require_request(engine).options[0].id)

    assert len(actor.hidden_influences) == 1
    assert len(target.hidden_influences) == 2
    assert engine.state.phase is GamePhase.AWAIT_ACTION


def test_truthful_claimant_may_intentionally_concede() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=11)
    actor = engine.state.player(engine.state.active_player_id)
    set_hidden_roles(engine, actor.id, (Role.DUKE, Role.CAPTAIN))

    choose(engine, "action:tax")
    choose(engine, "action-challenge:challenge")
    choose(engine, "claim:concede")
    choose(engine, require_request(engine).options[0].id)

    assert actor.coins == 2
    assert len(actor.hidden_influences) == 1


def test_exchange_keeps_correct_count_with_one_remaining_influence() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=12)
    actor = engine.state.player(engine.state.active_player_id)
    actor.influences[0].revealed = True
    court_count = len(engine.state.court_deck)

    choose(engine, "action:exchange")
    pass_all(engine, DecisionKind.ACTION_CHALLENGE)
    request = require_request(engine)

    assert request.kind is DecisionKind.EXCHANGE
    assert len(request.options) == 3
    assert all(len(option.data["card_ids"]) == 1 for option in request.options)
    choose(engine, request.options[0].id)

    assert len(actor.hidden_influences) == 1
    assert len(actor.revealed_influences) == 1
    assert len(engine.state.court_deck) == court_count
    assert_valid_state(engine.state)


def test_steal_transfers_only_the_coins_the_target_has() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=13)
    actor = engine.state.player(engine.state.active_player_id)
    target = next(player for player in engine.state.players if player.id != actor.id)
    set_coins(engine, target.id, 1)

    choose(engine, f"action:steal:{target.id}")
    pass_all(engine, DecisionKind.ACTION_CHALLENGE)
    assert require_request(engine).player_id == target.id
    choose(engine, "block:pass")

    assert actor.coins == 3
    assert target.coins == 0
    assert_valid_state(engine.state)
