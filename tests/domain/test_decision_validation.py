import pytest
from conftest import require_request

from evocoup.domain.decisions import Decision, DecisionError
from evocoup.domain.engine import GameEngine


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("request_id", "stale-request"),
        ("state_version", 99),
        ("player_id", "player-99"),
        ("option_id", "illegal-option"),
    ],
)
def test_invalid_decisions_do_not_mutate_state(field: str, value: str | int) -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=5)
    request = require_request(engine)
    values: dict[str, str | int] = {
        "request_id": request.id,
        "state_version": request.state_version,
        "player_id": request.player_id,
        "option_id": request.options[0].id,
    }
    values[field] = value
    before = engine.developer_view().state

    with pytest.raises(DecisionError):
        engine.apply_decision(Decision(**values))  # type: ignore[arg-type]

    assert engine.state == before


def test_accepted_decision_advances_version_and_invalidates_request() -> None:
    engine = GameEngine.new(["Ada", "Babbage", "Curie"], seed=5)
    request = require_request(engine)
    decision = Decision(
        request_id=request.id,
        state_version=request.state_version,
        player_id=request.player_id,
        option_id="action:income",
    )

    engine.apply_decision(decision)

    assert engine.state.version == 1
    with pytest.raises(DecisionError):
        engine.apply_decision(decision)
