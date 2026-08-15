"""In-memory match runner coordinating human and AI decision providers."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import StrEnum

from evocoup.application.providers import DecisionProvider, ProviderDecision
from evocoup.domain.decisions import Decision, DecisionError, DecisionRequest
from evocoup.domain.engine import GameEngine
from evocoup.domain.enums import GamePhase
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
    error_type: str | None = None
    error_message: str | None = None


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
                if request.player_id == self.human_player_id:
                    self.status = MatchStatus.WAITING_FOR_HUMAN
                    return self._update(tuple(emitted))
                if max_ai_decisions is not None and completed >= max_ai_decisions:
                    self.status = MatchStatus.PAUSED
                    return self._update(tuple(emitted))
                provider = self.providers[request.player_id]
                start = time.perf_counter()
                self._attempt += 1
                provider_decision: ProviderDecision | None = None
                try:
                    provider_decision = await provider.decide(
                        request,
                        self.engine.seat_view(request.player_id),
                    )
                    latency = time.perf_counter() - start
                    events = self.engine.apply_decision(
                        Decision(
                            request_id=request.id,
                            state_version=request.state_version,
                            player_id=request.player_id,
                            option_id=provider_decision.option_id,
                        )
                    )
                except Exception as error:
                    latency = time.perf_counter() - start
                    self.last_error = f"{type(error).__name__}: {error}"
                    self.status = MatchStatus.AGENT_ERROR
                    self.diagnostics.append(
                        AgentDiagnostic(
                            attempt=self._attempt,
                            player_id=request.player_id,
                            decision_id=request.id,
                            decision_kind=request.kind.value,
                            legal_option_ids=tuple(option.id for option in request.options),
                            selected_option_id=(
                                provider_decision.option_id if provider_decision else None
                            ),
                            rationale=provider_decision.rationale if provider_decision else None,
                            model=provider_decision.model if provider_decision else None,
                            usage=provider_decision.usage if provider_decision else None,
                            request_payload=(
                                provider_decision.request_payload if provider_decision else None
                            ),
                            raw_response=(
                                provider_decision.raw_response if provider_decision else None
                            ),
                            latency_seconds=latency,
                            error_type=type(error).__name__,
                            error_message=str(error),
                        )
                    )
                    return self._update(tuple(emitted))
                self.diagnostics.append(
                    AgentDiagnostic(
                        attempt=self._attempt,
                        player_id=request.player_id,
                        decision_id=request.id,
                        decision_kind=request.kind.value,
                        legal_option_ids=tuple(option.id for option in request.options),
                        selected_option_id=provider_decision.option_id,
                        rationale=provider_decision.rationale,
                        model=provider_decision.model,
                        usage=provider_decision.usage,
                        request_payload=provider_decision.request_payload,
                        raw_response=provider_decision.raw_response,
                        latency_seconds=latency,
                    )
                )
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
