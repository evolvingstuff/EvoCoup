from collections import deque

import pytest

from evocoup.application.match import Match, MatchMode, MatchStatus
from evocoup.application.providers import FirstLegalProvider, ProviderDecision
from evocoup.domain.decisions import Decision, DecisionRequest
from evocoup.domain.views import SeatGameView


class FailingThenFirstProvider:
    def __init__(self) -> None:
        self.fail = True
        self.views: list[SeatGameView] = []

    async def decide(self, request: DecisionRequest, view: SeatGameView) -> ProviderDecision:
        self.views.append(view)
        if self.fail:
            raise TimeoutError("model timed out")
        return ProviderDecision(request.options[0].id, "test choice")


class QueueProvider:
    def __init__(self, option_ids: list[str]) -> None:
        self.option_ids = deque(option_ids)

    async def decide(self, request: DecisionRequest, view: SeatGameView) -> ProviderDecision:
        del view
        if self.option_ids:
            return ProviderDecision(self.option_ids.popleft(), "queued test choice")
        return ProviderDecision(request.options[0].id, "default test choice")


@pytest.mark.asyncio
async def test_human_match_advances_until_human_decision() -> None:
    match = Match.create(
        3,
        mode=MatchMode.HUMAN_VS_AI,
        provider=FirstLegalProvider(),
        seed=1,
    )

    update = await match.advance()

    assert update.status is MatchStatus.WAITING_FOR_HUMAN
    assert match.pending_request is not None
    assert match.pending_request.player_id == match.human_player_id


@pytest.mark.asyncio
async def test_human_submission_continues_to_next_human_prompt() -> None:
    match = Match.create(
        2,
        mode=MatchMode.HUMAN_VS_AI,
        provider=FirstLegalProvider(),
        seed=2,
    )
    await match.advance()
    request = match.pending_request
    assert request is not None

    update = await match.submit_human(
        Decision(
            request_id=request.id,
            state_version=request.state_version,
            player_id=request.player_id,
            option_id=request.options[0].id,
        )
    )

    assert update.status in {MatchStatus.WAITING_FOR_HUMAN, MatchStatus.FINISHED}
    assert match.engine.state.version >= 1


@pytest.mark.asyncio
async def test_ai_only_step_applies_exactly_one_external_decision() -> None:
    match = Match.create(
        3,
        mode=MatchMode.AI_ONLY,
        provider=FirstLegalProvider(),
        seed=3,
    )

    update = await match.step()

    assert update.status is MatchStatus.PAUSED
    assert match.engine.state.version == 1
    assert len(match.diagnostics) == 1


@pytest.mark.asyncio
async def test_ai_only_play_finishes_match() -> None:
    match = Match.create(
        3,
        mode=MatchMode.AI_ONLY,
        provider=FirstLegalProvider(),
        seed=4,
    )

    update = await match.play()

    assert update.status is MatchStatus.FINISHED
    assert match.engine.state.winner_id is not None
    assert match.diagnostics


@pytest.mark.asyncio
async def test_agent_error_preserves_pending_decision_and_manual_retry() -> None:
    provider = FailingThenFirstProvider()
    match = Match.create(3, mode=MatchMode.AI_ONLY, provider=provider, seed=5)
    before = match.pending_request
    assert before is not None

    failed = await match.step()

    assert failed.status is MatchStatus.AGENT_ERROR
    assert match.engine.state.version == 0
    assert match.pending_request == before
    assert match.last_error == "TimeoutError: model timed out"
    assert match.diagnostics[-1].error_type == "TimeoutError"

    provider.fail = False
    retried = await match.retry()

    assert retried.status is MatchStatus.PAUSED
    assert match.engine.state.version == 1
    assert match.last_error is None
    assert len(match.diagnostics) == 2


@pytest.mark.asyncio
async def test_illegal_provider_choice_stops_without_fallback() -> None:
    provider = QueueProvider(["invented-action"])
    match = Match.create(3, mode=MatchMode.AI_ONLY, provider=provider, seed=6)

    update = await match.step()

    assert update.status is MatchStatus.AGENT_ERROR
    assert match.engine.state.version == 0
    assert match.diagnostics[-1].error_type == "DecisionError"


@pytest.mark.asyncio
async def test_provider_receives_only_its_seat_view() -> None:
    provider = FailingThenFirstProvider()
    match = Match.create(3, mode=MatchMode.AI_ONLY, provider=provider, seed=7)
    request = match.pending_request
    assert request is not None

    await match.step()

    view = provider.views[0]
    assert view.player_id == request.player_id
    assert len(view.hidden_cards) == 2
    opponent_ids = {
        influence.card.id
        for player in match.engine.state.players
        if player.id != request.player_id
        for influence in player.hidden_influences
    }
    assert all(card.id not in opponent_ids for card in view.hidden_cards)
