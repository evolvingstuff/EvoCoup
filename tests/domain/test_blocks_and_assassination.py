from conftest import choose, pass_all, require_request, set_coins, set_hidden_roles

from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import DecisionKind, EventType, GamePhase, Role
from evocoup.domain.invariants import assert_valid_state


def test_unchallenged_foreign_aid_block_cancels_action() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=20)
    actor = engine.state.player(engine.state.active_player_id)

    choose(engine, "action:foreign_aid")
    blocker_id = require_request(engine).player_id
    choose(engine, "block:duke")
    pass_all(engine, DecisionKind.BLOCK_CHALLENGE)

    assert actor.coins == 2
    assert engine.state.phase is GamePhase.AWAIT_ACTION
    assert any(
        event.type is EventType.BLOCK_SUCCEEDED and event.actor_id == blocker_id
        for event in engine.state.history
    )


def test_caught_false_block_allows_foreign_aid_to_resolve() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=21)
    actor = engine.state.player(engine.state.active_player_id)

    choose(engine, "action:foreign_aid")
    blocker = engine.state.player(require_request(engine).player_id)
    set_hidden_roles(engine, blocker.id, (Role.ASSASSIN, Role.CONTESSA))
    choose(engine, "block:duke")
    challenger_id = require_request(engine).player_id
    choose(engine, "block-challenge:challenge")
    public = engine.public_view()
    assert public.pending_block is not None
    assert public.pending_block.blocker_id == blocker.id
    assert public.pending_challenge is not None
    assert public.pending_challenge.claimant_id == blocker.id
    assert public.pending_challenge.challenger_id == challenger_id
    choose(engine, "claim:concede")
    choose(engine, require_request(engine).options[0].id)

    assert actor.coins == 4
    assert len(blocker.hidden_influences) == 1
    assert engine.state.phase is GamePhase.AWAIT_ACTION
    assert_valid_state(engine.state)


def test_proven_block_penalizes_challenger_and_cancels_action() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=22)
    actor = engine.state.player(engine.state.active_player_id)

    choose(engine, "action:foreign_aid")
    blocker = engine.state.player(require_request(engine).player_id)
    set_hidden_roles(engine, blocker.id, (Role.DUKE, Role.CONTESSA))
    choose(engine, "block:duke")
    challenger = engine.state.player(require_request(engine).player_id)
    choose(engine, "block-challenge:challenge")
    choose(engine, "claim:prove")
    choose(engine, require_request(engine).options[0].id)

    assert actor.coins == 2
    assert len(challenger.hidden_influences) == 1
    assert engine.state.phase is GamePhase.AWAIT_ACTION


def test_only_target_can_block_assassination_or_steal() -> None:
    for action, role, coins in (
        ("assassinate", Role.ASSASSIN, 3),
        ("steal", Role.CAPTAIN, 2),
    ):
        engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=23)
        actor = engine.state.player(engine.state.active_player_id)
        target = next(player for player in engine.state.players if player.id != actor.id)
        set_hidden_roles(engine, actor.id, (role, Role.DUKE))
        set_coins(engine, actor.id, coins)

        choose(engine, f"action:{action}:{target.id}")
        pass_all(engine, DecisionKind.ACTION_CHALLENGE)

        block_request = require_request(engine)
        assert block_request.kind is DecisionKind.BLOCK
        assert block_request.player_id == target.id
        assert actor.name in block_request.prompt
        assert target.name in block_request.prompt
        assert action.title() in block_request.prompt


def test_false_contessa_challenge_can_cost_target_two_influences() -> None:
    engine = GameEngine.new(["Ada", "Babbage"], seed=24, two_player_variant=False)
    actor = engine.state.player(engine.state.active_player_id)
    target = next(player for player in engine.state.players if player.id != actor.id)
    set_hidden_roles(engine, actor.id, (Role.ASSASSIN, Role.DUKE))
    set_hidden_roles(engine, target.id, (Role.CAPTAIN, Role.AMBASSADOR))
    set_coins(engine, actor.id, 3)

    choose(engine, f"action:assassinate:{target.id}")
    choose(engine, "action-challenge:pass")
    choose(engine, "block:contessa")
    choose(engine, "block-challenge:challenge")
    choose(engine, "claim:concede")
    first_loss = require_request(engine)
    assert first_loss.player_id == target.id
    assert first_loss.prompt.startswith("You lost a challenge")
    assert first_loss.prompt.endswith("Choose an influence to reveal.")
    choose(engine, first_loss.options[0].id)
    second_loss = require_request(engine)
    assert second_loss.kind is DecisionKind.LOSE_INFLUENCE
    assert second_loss.player_id == target.id
    choose(engine, second_loss.options[0].id)

    assert engine.state.phase is GamePhase.FINISHED
    assert engine.state.winner_id == actor.id
    assert actor.coins == 0
    assert target.coins == 0
    assert_valid_state(engine.state)


def test_failed_challenge_of_truthful_assassin_can_cost_two_influences() -> None:
    engine = GameEngine.new(["Ada", "Babbage"], seed=25, two_player_variant=False)
    actor = engine.state.player(engine.state.active_player_id)
    target = next(player for player in engine.state.players if player.id != actor.id)
    set_hidden_roles(engine, actor.id, (Role.ASSASSIN, Role.DUKE))
    set_coins(engine, actor.id, 3)

    choose(engine, f"action:assassinate:{target.id}")
    choose(engine, "action-challenge:challenge")
    choose(engine, "claim:prove")
    choose(engine, require_request(engine).options[0].id)
    assert len(target.hidden_influences) == 1
    assert require_request(engine).kind is DecisionKind.BLOCK
    choose(engine, "block:pass")
    choose(engine, require_request(engine).options[0].id)

    assert engine.state.phase is GamePhase.FINISHED
    assert engine.state.winner_id == actor.id
    assert_valid_state(engine.state)


def test_successfully_blocked_assassination_does_not_refund_cost() -> None:
    engine = GameEngine.new(["Ada", "Babbage"], seed=26, two_player_variant=False)
    actor = engine.state.player(engine.state.active_player_id)
    target = next(player for player in engine.state.players if player.id != actor.id)
    set_hidden_roles(engine, actor.id, (Role.ASSASSIN, Role.DUKE))
    set_coins(engine, actor.id, 3)

    choose(engine, f"action:assassinate:{target.id}")
    choose(engine, "action-challenge:pass")
    choose(engine, "block:contessa")
    choose(engine, "block-challenge:pass")

    assert actor.coins == 0
    assert len(target.hidden_influences) == 2
    assert engine.state.phase is GamePhase.AWAIT_ACTION
