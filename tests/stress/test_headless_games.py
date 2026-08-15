import random

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from evocoup.domain.decisions import Decision
from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import GamePhase
from evocoup.domain.invariants import assert_valid_state


def play_game(
    player_count: int,
    game_seed: int,
    *,
    policy_seed: int,
    max_decisions: int = 2_000,
) -> GameEngine:
    engine = GameEngine.new(
        [f"Player {index + 1}" for index in range(player_count)],
        seed=game_seed,
        game_id=f"stress-{player_count}-{game_seed}",
    )
    policy = random.Random(policy_seed)
    for _ in range(max_decisions):
        request = engine.pending_decision()
        if request is None:
            assert engine.state.phase is GamePhase.FINISHED
            assert_valid_state(engine.state)
            return engine
        option = policy.choice(request.options)
        engine.apply_decision(
            Decision(
                request_id=request.id,
                state_version=request.state_version,
                player_id=request.player_id,
                option_id=option.id,
            )
        )
    pytest.fail(
        f"game did not finish within {max_decisions} decisions "
        f"(players={player_count}, game_seed={game_seed}, policy_seed={policy_seed})"
    )


@given(
    player_count=st.integers(min_value=2, max_value=6),
    game_seed=st.integers(min_value=0, max_value=2**32 - 1),
    policy_seed=st.integers(min_value=0, max_value=2**32 - 1),
)
@settings(max_examples=150, deadline=None)
def test_random_legal_policies_finish_without_violating_invariants(
    player_count: int,
    game_seed: int,
    policy_seed: int,
) -> None:
    play_game(player_count, game_seed, policy_seed=policy_seed)


@pytest.mark.parametrize("player_count", range(2, 7))
def test_first_legal_option_policy_finishes(player_count: int) -> None:
    engine = GameEngine.new(
        [f"Player {index + 1}" for index in range(player_count)],
        seed=100 + player_count,
    )
    for _ in range(2_000):
        request = engine.pending_decision()
        if request is None:
            assert engine.state.phase is GamePhase.FINISHED
            return
        engine.apply_decision(
            Decision(
                request_id=request.id,
                state_version=request.state_version,
                player_id=request.player_id,
                option_id=request.options[0].id,
            )
        )
    pytest.fail(f"first-option policy did not terminate for {player_count} players")


def test_seeded_game_and_policy_are_reproducible() -> None:
    first = play_game(6, 9001, policy_seed=17)
    second = play_game(6, 9001, policy_seed=17)

    assert first.state.winner_id == second.state.winner_id
    assert [event.message for event in first.state.history] == [
        event.message for event in second.state.history
    ]


@pytest.mark.long
def test_ten_thousand_seeded_games() -> None:
    for index in range(10_000):
        player_count = 2 + (index % 5)
        play_game(player_count, index, policy_seed=index ^ 0xC0FFEE)
