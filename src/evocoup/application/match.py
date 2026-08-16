"""In-memory match runner coordinating human and AI decision providers."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import StrEnum

from evocoup.application.providers import DecisionProvider, ProviderDecision
from evocoup.domain.decisions import Decision, DecisionError, DecisionRequest
from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import DecisionKind, GamePhase
from evocoup.domain.events import GameEvent


class MatchMode(StrEnum):
    HUMAN_VS_AI = "human_vs_ai"
    AI_ONLY = "ai_only"


class MatchStatus(StrEnum):
    RUNNING = "running"
    PAUSED = "paused"
    WAITING_FOR_HUMAN = "waiting_for_human"
    AGENT_ERROR = "agent_error"
    FINISHED = "finished"


@dataclass(frozen=True, slots=True)
class AgentDiagnostic:
    attempt: int
    player_id: str
    decision_id: str
    decision_kind: str
    legal_option_ids: tuple[str, ...]
    selected_option_id: str | None
    rationale: str | None
    model: str | None
    usage: dict[str, object] | None
    request_payload: dict[str, object] | None
    raw_response: dict[str, object] | None
    latency_seconds: float
    provider_attempts: int = 1
    error_type: str | None = None
    error_message: str | None = None
    applied: bool = True


@dataclass(frozen=True, slots=True)
class _ProviderCall:
    attempt: int
    request: DecisionRequest
    decision: ProviderDecision | None
    latency_seconds: float
    provider_attempts: int
    error: Exception | None = None


@dataclass(frozen=True, slots=True)
class MatchUpdate:
    events: tuple[GameEvent, ...]
    status: MatchStatus
    state_version: int


@dataclass(slots=True)
class Match:
    engine: GameEngine
    mode: MatchMode
    providers: dict[str, DecisionProvider]
    human_player_id: str | None
    status: MatchStatus
    diagnostics: list[AgentDiagnostic] = field(default_factory=list)
    last_error: str | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _attempt: int = 0
    _thinking_requests: tuple[DecisionRequest, ...] = field(default=(), repr=False)
    _response_calls: dict[tuple[DecisionKind, str], _ProviderCall] = field(
        default_factory=dict,
        repr=False,
    )

    @classmethod
    def create(
        cls,
        player_count: int,
        *,
        mode: MatchMode,
        provider: DecisionProvider,
        seed: int | None = None,
        game_id: str = "current",
    ) -> Match:
        names = ["You"] if mode is MatchMode.HUMAN_VS_AI else []
        names.extend(f"Agent {index + 1}" for index in range(player_count - len(names)))
        engine = GameEngine.new(names, seed=seed, game_id=game_id)
        human_player_id = engine.state.players[0].id if mode is MatchMode.HUMAN_VS_AI else None
        providers = {
            player.id: provider for player in engine.state.players if player.id != human_player_id
        }
        initial_status = (
            MatchStatus.RUNNING if mode is MatchMode.HUMAN_VS_AI else MatchStatus.PAUSED
        )
        return cls(
            engine=engine,
            mode=mode,
            providers=providers,
            human_player_id=human_player_id,
            status=initial_status,
        )

    @property
    def pending_request(self) -> DecisionRequest | None:
        return self.engine.pending_decision()

    @property
    def thinking_requests(self) -> tuple[DecisionRequest, ...]:
        return self._thinking_requests

    async def _call_provider(self, request: DecisionRequest, attempt: int) -> _ProviderCall:
        start = time.perf_counter()
        view = self.engine.decision_view(request)
        retry_delays = (0.15, 0.35)
        last_error: Exception | None = None
        for provider_attempt in range(1, len(retry_delays) + 2):
            try:
                decision = await self.providers[request.player_id].decide(request, view)
                return _ProviderCall(
                    attempt=attempt,
                    request=request,
                    decision=decision,
                    latency_seconds=time.perf_counter() - start,
                    provider_attempts=provider_attempt,
                )
            except Exception as error:
                last_error = error
                if provider_attempt <= len(retry_delays):
                    await asyncio.sleep(retry_delays[provider_attempt - 1])
        assert last_error is not None
        return _ProviderCall(
            attempt=attempt,
            request=request,
            decision=None,
            latency_seconds=time.perf_counter() - start,
            provider_attempts=len(retry_delays) + 1,
            error=last_error,
        )

    def _record_call(
        self,
        call: _ProviderCall,
        *,
        applied: bool,
        error: Exception | None = None,
    ) -> None:
        failure = error or call.error
        decision = call.decision
        self.diagnostics.append(
            AgentDiagnostic(
                attempt=call.attempt,
                player_id=call.request.player_id,
                decision_id=call.request.id,
                decision_kind=call.request.kind.value,
                legal_option_ids=tuple(option.id for option in call.request.options),
                selected_option_id=decision.option_id if decision else None,
                rationale=decision.rationale if decision else None,
                model=decision.model if decision else None,
                usage=decision.usage if decision else None,
                request_payload=decision.request_payload if decision else None,
                raw_response=decision.raw_response if decision else None,
                latency_seconds=call.latency_seconds,
                provider_attempts=call.provider_attempts,
                error_type=type(failure).__name__ if failure else None,
                error_message=str(failure) if failure else None,
                applied=applied,
            )
        )

    async def advance(self, *, max_ai_decisions: int | None = None) -> MatchUpdate:
        """Run AI decisions until a boundary, error, human prompt, or completion."""

        async with self._lock:
            if self.status is MatchStatus.AGENT_ERROR:
                return self._update(())
            if self.status is MatchStatus.PAUSED and max_ai_decisions is None:
                return self._update(())
            self.status = MatchStatus.RUNNING
            emitted: list[GameEvent] = []
            completed = 0
            while True:
                request = self.engine.pending_decision()
                if request is None:
                    self.status = MatchStatus.FINISHED
                    return self._update(tuple(emitted))
                if request.kind is DecisionKind.LOSE_INFLUENCE and len(request.options) == 1:
                    option = request.options[0]
                    events = self.engine.apply_decision(
                        Decision(
                            request_id=request.id,
                            state_version=request.state_version,
                            player_id=request.player_id,
                            option_id=option.id,
                        )
                    )
                    emitted.extend(events)
                    continue
                if max_ai_decisions is not None and completed >= max_ai_decisions:
                    self.status = MatchStatus.PAUSED
                    return self._update(tuple(emitted))

                response_candidates = self.engine.pending_response_decisions()
                valid_response_keys = {
                    (candidate.kind, candidate.player_id) for candidate in response_candidates
                }
                stale_keys = [key for key in self._response_calls if key not in valid_response_keys]
                for key in stale_keys:
                    self._record_call(self._response_calls.pop(key), applied=False)

                if response_candidates:
                    missing_candidates = tuple(
                        candidate
                        for candidate in response_candidates
                        if candidate.player_id != self.human_player_id
                        and (candidate.kind, candidate.player_id) not in self._response_calls
                    )
                    scheduled: list[tuple[DecisionRequest, int]] = []
                    for parallel_request in missing_candidates:
                        self._attempt += 1
                        scheduled.append((parallel_request, self._attempt))
                    if scheduled:
                        self._thinking_requests = missing_candidates
                        try:
                            calls = await asyncio.gather(
                                *(
                                    self._call_provider(parallel_request, attempt)
                                    for parallel_request, attempt in scheduled
                                )
                            )
                        finally:
                            self._thinking_requests = ()
                        self._response_calls.update(
                            ((call.request.kind, call.request.player_id), call) for call in calls
                        )

                    if request.player_id == self.human_player_id:
                        self.status = MatchStatus.WAITING_FOR_HUMAN
                        return self._update(tuple(emitted))

                    call = self._response_calls.pop((request.kind, request.player_id))
                    if call.error is not None:
                        self._record_call(call, applied=True)
                        error = call.error
                        self.last_error = f"{type(error).__name__}: {error}"
                        self.status = MatchStatus.AGENT_ERROR
                        return self._update(tuple(emitted))
                    decision = call.decision
                    assert decision is not None
                    try:
                        events = self.engine.apply_decision(
                            Decision(
                                request_id=request.id,
                                state_version=request.state_version,
                                player_id=request.player_id,
                                option_id=decision.option_id,
                            )
                        )
                    except Exception as error:
                        self._record_call(call, applied=True, error=error)
                        self.last_error = f"{type(error).__name__}: {error}"
                        self.status = MatchStatus.AGENT_ERROR
                        return self._update(tuple(emitted))
                    self._record_call(call, applied=True)
                    emitted.extend(events)
                    continue

                if request.player_id == self.human_player_id:
                    self.status = MatchStatus.WAITING_FOR_HUMAN
                    return self._update(tuple(emitted))

                self._attempt += 1
                self._thinking_requests = (request,)
                try:
                    call = await self._call_provider(request, self._attempt)
                finally:
                    self._thinking_requests = ()
                if call.error is not None:
                    self._record_call(call, applied=True)
                    call_error = call.error
                    self.last_error = f"{type(call_error).__name__}: {call_error}"
                    self.status = MatchStatus.AGENT_ERROR
                    return self._update(tuple(emitted))
                provider_decision = call.decision
                assert provider_decision is not None
                try:
                    events = self.engine.apply_decision(
                        Decision(
                            request_id=request.id,
                            state_version=request.state_version,
                            player_id=request.player_id,
                            option_id=provider_decision.option_id,
                        )
                    )
                except Exception as error:
                    self._record_call(call, applied=True, error=error)
                    self.last_error = f"{type(error).__name__}: {error}"
                    self.status = MatchStatus.AGENT_ERROR
                    return self._update(tuple(emitted))
                self._record_call(call, applied=True)
                emitted.extend(events)
                completed += 1

    async def submit_human(self, decision: Decision) -> MatchUpdate:
        """Apply a human decision and advance through subsequent AI decisions."""

        async with self._lock:
            if self.human_player_id is None:
                raise DecisionError("this match does not have a human player")
            request = self.engine.pending_decision()
            if request is None or request.player_id != self.human_player_id:
                raise DecisionError("the match is not waiting for a human decision")
            events = self.engine.apply_decision(decision)
            self.status = MatchStatus.RUNNING
        continuation = await self.advance()
        return MatchUpdate(
            events=events + continuation.events,
            status=continuation.status,
            state_version=continuation.state_version,
        )

    async def retry(self) -> MatchUpdate:
        """Retry the unchanged AI decision after an agent error."""

        if self.status is not MatchStatus.AGENT_ERROR:
            raise RuntimeError("match is not stopped on an agent error")
        self.last_error = None
        self.status = MatchStatus.RUNNING
        return await self.advance(max_ai_decisions=1 if self.mode is MatchMode.AI_ONLY else None)

    async def step(self) -> MatchUpdate:
        if self.mode is not MatchMode.AI_ONLY:
            raise RuntimeError("step is available only for AI-only matches")
        if self.status is MatchStatus.AGENT_ERROR:
            raise RuntimeError("retry the failed decision before stepping")
        return await self.advance(max_ai_decisions=1)

    async def play(self) -> MatchUpdate:
        if self.mode is not MatchMode.AI_ONLY:
            raise RuntimeError("play is available only for AI-only matches")
        if self.status is MatchStatus.AGENT_ERROR:
            raise RuntimeError("retry the failed decision before playing")
        self.status = MatchStatus.RUNNING
        return await self.advance()

    def _update(self, events: tuple[GameEvent, ...]) -> MatchUpdate:
        if self.engine.state.phase is GamePhase.FINISHED:
            self.status = MatchStatus.FINISHED
        return MatchUpdate(
            events=events,
            status=self.status,
            state_version=self.engine.state.version,
        )
