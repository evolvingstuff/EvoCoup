from typing import Any

import pytest

from evocoup.agents.openai_agent import AgentDecisionOutput, OpenAIDecisionProvider
from evocoup.agents.prompts import PROMPT_VERSION, SYSTEM_PROMPT
from evocoup.domain.engine import GameEngine


class FakeUsage:
    def model_dump(self, *, mode: str) -> dict[str, int]:
        assert mode == "json"
        return {"input_tokens": 100, "output_tokens": 12, "total_tokens": 112}


class FakeResponse:
    def __init__(self, parsed: AgentDecisionOutput | None) -> None:
        self.output_parsed = parsed
        self.model = "gpt-test-snapshot"
        self.usage = FakeUsage()

    def model_dump(self, *, mode: str) -> dict[str, Any]:
        assert mode == "json"
        return {"id": "response-test", "model": self.model}


class FakeResponses:
    def __init__(self, parsed: AgentDecisionOutput | None) -> None:
        self.parsed = parsed
        self.kwargs: dict[str, Any] = {}

    async def parse(self, **kwargs: Any) -> FakeResponse:
        self.kwargs = kwargs
        return FakeResponse(self.parsed)


class FakeClient:
    def __init__(self, parsed: AgentDecisionOutput | None) -> None:
        self.responses = FakeResponses(parsed)


@pytest.mark.asyncio
async def test_openai_provider_uses_structured_seat_safe_request() -> None:
    engine = GameEngine.new(["A", "B", "C"], seed=101)
    request = engine.pending_decision()
    assert request is not None
    client = FakeClient(
        AgentDecisionOutput(choice_id=request.options[0].id, rationale="Safest move.")
    )
    provider = OpenAIDecisionProvider(api_key="test", client=client)
    agent_name = engine.state.player(request.player_id).name
    provider.set_session_memory(
        {
            agent_name: [
                {
                    "result": "lost",
                    "my_private_decisions": [
                        {
                            "held_roles": ["captain"],
                            "claimed_role": "duke",
                            "knowingly_bluffed": True,
                        }
                    ],
                }
            ]
        },
        {request.player_id: agent_name},
    )

    result = await provider.decide(request, engine.seat_view(request.player_id))

    assert result.option_id == request.options[0].id
    assert result.rationale == "Safest move."
    assert result.model == "gpt-test-snapshot"
    assert result.usage == {"input_tokens": 100, "output_tokens": 12, "total_tokens": 112}
    assert result.request_payload["prompt_version"] == PROMPT_VERSION
    assert result.request_payload["agent_identity"] == agent_name
    assert result.request_payload["prior_court_memory"][0]["result"] == "lost"
    assert result.request_payload["prior_court_memory"][0]["my_private_decisions"][0][
        "knowingly_bluffed"
    ] is True
    assert client.responses.kwargs["instructions"] == SYSTEM_PROMPT
    assert client.responses.kwargs["text_format"] is AgentDecisionOutput
    assert client.responses.kwargs["store"] is False

    opponents = [player for player in engine.state.players if player.id != request.player_id]
    serialized_input = client.responses.kwargs["input"]
    for opponent in opponents:
        for influence in opponent.hidden_influences:
            assert influence.card.id not in serialized_input


@pytest.mark.asyncio
async def test_openai_provider_rejects_missing_parsed_output() -> None:
    engine = GameEngine.new(["A", "B", "C"], seed=102)
    request = engine.pending_decision()
    assert request is not None
    provider = OpenAIDecisionProvider(api_key="test", client=FakeClient(None))

    with pytest.raises(ValueError, match="parsed decision"):
        await provider.decide(request, engine.seat_view(request.player_id))


def test_system_prompt_contains_the_action_and_challenge_reference() -> None:
    assert PROMPT_VERSION == "coup-player-v3-session-memory"
    for rule_term in (
        "Income",
        "Foreign Aid",
        "Coup",
        "Tax",
        "Assassinate",
        "Steal",
        "Exchange",
        "10 or more coins",
        "challenge",
        "block",
        "refund",
        "another to the assassination",
        "Prior court memory",
        "knew you were bluffing",
    ):
        assert rule_term in SYSTEM_PROMPT
