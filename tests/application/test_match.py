import asyncio
from collections import deque

import pytest

from evocoup.application.match import Match, MatchMode, MatchStatus
from evocoup.application.providers import FirstLegalProvider, ProviderDecision
from evocoup.domain.decisions import Decision, DecisionRequest
from evocoup.domain.enums import Continuation, DecisionKind, GamePhase
from evocoup.domain.models import PendingInfluenceLoss
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


class TransientFailureProvider:
    def __init__(self, failures: int) -> None:
        self.failures = failures
        self.calls = 0

    async def decide(self, request: DecisionRequest, view: SeatGameView) -> ProviderDecision:
        del view
        self.calls += 1
        if self.calls <= self.failures:
            raise TimeoutError("temporary provider failure")
        return ProviderDecision(request.options[0].id, "recovered test choice")


class ParallelResponseProvider:
    def __init__(self, *, stop_after_response: bool = True) -> None:
        self.active_responses = 0
        self.max_active_responses = 0
        self.response_calls = 0
        self.stop_after_response = stop_after_response

    async def decide(self, request: DecisionRequest, view: SeatGameView) -> ProviderDecision:
        del view
        if request.kind in {
            DecisionKind.ACTION_CHALLENGE,
            DecisionKind.BLOCK,
            DecisionKind.BLOCK_CHALLENGE,
        }:
            self.response_calls += 1
            self.active_responses += 1
            self.max_active_responses = max(
                self.max_active_responses,
                self.active_responses,
            )
            await asyncio.sleep(0.02)
            self.active_responses -= 1
            return ProviderDecision(request.options[0].id, "pass")
        if not self.stop_after_response:
            tax = next((option for option in request.options if option.id == "action:tax"), None)
            return ProviderDecision((tax or request.options[0]).id, "continue after responses")
        raise RuntimeError("stop after the response window")


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
    assert match.diagnostics[-1].provider_attempts == 3

    provider.fail = False
    retried = await match.retry()

    assert retried.status is MatchStatus.PAUSED
    assert match.engine.state.version == 1
    assert match.last_error is None
    assert len(match.diagnostics) == 2


@pytest.mark.asyncio
async def test_agent_call_retries_twice_before_succeeding() -> None:
    provider = TransientFailureProvider(failures=2)
    match = Match.create(3, mode=MatchMode.AI_ONLY, provider=provider, seed=51)

    update = await match.step()

    assert update.status is MatchStatus.PAUSED
    assert match.engine.state.version == 1
    assert provider.calls == 3
    assert match.diagnostics[-1].provider_attempts == 3
    assert match.diagnostics[-1].error_type is None


@pytest.mark.asyncio
async def test_response_window_calls_agents_in_parallel_but_applies_clockwise() -> None:
    provider = ParallelResponseProvider()
    match = Match.create(4, mode=MatchMode.AI_ONLY, provider=provider, seed=52)
    action_request = match.pending_request
    assert action_request is not None
    tax = next(option for option in action_request.options if option.id == "action:tax")
    match.engine.apply_decision(
        Decision(
            request_id=action_request.id,
            state_version=action_request.state_version,
            player_id=action_request.player_id,
            option_id=tax.id,
        )
    )
    expected_order = list(match.engine.state.response_queue)

    update = await match.play()

    assert update.status is MatchStatus.AGENT_ERROR
    assert provider.max_active_responses == len(expected_order)
    response_diagnostics = [
        diagnostic
        for diagnostic in match.diagnostics
        if diagnostic.decision_kind == DecisionKind.ACTION_CHALLENGE.value
    ]
    assert [diagnostic.player_id for diagnostic in response_diagnostics] == expected_order
    assert all(diagnostic.applied for diagnostic in response_diagnostics)


@pytest.mark.asyncio
async def test_step_resolves_response_window_then_starts_next_real_decision() -> None:
    provider = ParallelResponseProvider(stop_after_response=False)
    match = Match.create(4, mode=MatchMode.AI_ONLY, provider=provider, seed=53)
    action_request = match.pending_request
    assert action_request is not None
    tax = next(option for option in action_request.options if option.id == "action:tax")
    match.engine.apply_decision(
        Decision(
            request_id=action_request.id,
            state_version=action_request.state_version,
            player_id=action_request.player_id,
            option_id=tax.id,
        )
    )
    response_count = len(match.engine.state.response_queue)

    update = await match.step()

    assert update.status is MatchStatus.PAUSED
    assert provider.response_calls == response_count
    assert provider.max_active_responses == response_count
    assert len(match.diagnostics) == response_count + 1
    assert match.engine.state.phase is GamePhase.ACTION_CHALLENGE


@pytest.mark.asyncio
async def test_agents_prefetch_responses_on_both_sides_of_human_seat() -> None:
    provider = ParallelResponseProvider()
    match = Match.create(4, mode=MatchMode.HUMAN_VS_AI, provider=provider, seed=54)
    actor = match.engine.state.players[1]
    match.engine.state.active_player_id = actor.id
    action_request = match.pending_request
    assert action_request is not None
    tax = next(option for option in action_request.options if option.id == "action:tax")
    match.engine.apply_decision(
        Decision(
            request_id=action_request.id,
            state_version=action_request.state_version,
            player_id=action_request.player_id,
            option_id=tax.id,
        )
    )

    update = await match.advance()

    assert update.status is MatchStatus.WAITING_FOR_HUMAN
    assert provider.response_calls == 2
    assert provider.max_active_responses == 2
    assert match.pending_request is not None
    assert match.pending_request.player_id == match.human_player_id


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


@pytest.mark.asyncio
async def test_single_remaining_influence_is_revealed_automatically() -> None:
    match = Match.create(
        3,
        mode=MatchMode.HUMAN_VS_AI,
        provider=FirstLegalProvider(),
        seed=8,
    )
    human = match.engine.state.player(match.human_player_id or "")
    human.influences[0].revealed = True
    match.engine.state.phase = GamePhase.INFLUENCE_LOSS
    match.engine.state.pending_influence_loss = PendingInfluenceLoss(
        player_id=human.id,
        reason="test loss",
        continuation=Continuation.END_TURN,
    )
    request = match.pending_request
    assert request is not None
    assert request.kind is DecisionKind.LOSE_INFLUENCE
    assert len(request.options) == 1

    await match.advance(max_ai_decisions=0)

    assert human.hidden_influences == []
    assert (
        match.pending_request is None
        or match.pending_request.kind is not DecisionKind.LOSE_INFLUENCE
    )
