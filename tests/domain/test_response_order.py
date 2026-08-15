from conftest import choose, require_request

from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import DecisionKind


def test_action_challenges_are_offered_clockwise_and_passes_are_final() -> None:
    engine = GameEngine.new(["A", "B", "C", "D"], seed=30)
    actor = engine.state.player(engine.state.active_player_id)
    expected = [
        player_id
        for player_id in engine._clockwise_ids(engine.state.players, actor.id)
        if player_id != actor.id
    ]

    choose(engine, "action:tax")
    observed = []
    while require_request(engine).kind is DecisionKind.ACTION_CHALLENGE:
        observed.append(require_request(engine).player_id)
        choose(engine, "action-challenge:pass")

    assert observed == expected
    assert engine.state.player(actor.id).coins == 5


def test_first_challenge_ends_the_response_window() -> None:
    engine = GameEngine.new(["A", "B", "C", "D"], seed=31)
    actor = engine.state.player(engine.state.active_player_id)

    choose(engine, "action:tax")
    first_challenger = require_request(engine).player_id
    choose(engine, "action-challenge:challenge")

    claim_request = require_request(engine)
    assert claim_request.kind is DecisionKind.CLAIM_RESPONSE
    assert claim_request.player_id == actor.id
    assert first_challenger not in engine.state.response_queue
