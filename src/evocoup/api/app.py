"""Local FastAPI application for the current in-memory match."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.encoders import jsonable_encoder

from evocoup.agents.openai_agent import OpenAIDecisionProvider
from evocoup.api.schemas import ControlRequest, CreateGameRequest, SubmitDecisionRequest
from evocoup.api.settings import Settings
from evocoup.application.match import Match, MatchMode
from evocoup.application.providers import DecisionProvider, MissingAPIKeyProvider
from evocoup.domain.decisions import Decision, DecisionError


class Runtime:
    def __init__(self, provider: DecisionProvider) -> None:
        self.provider = provider
        self.current_match: Match | None = None
        self.websockets: list[WebSocket] = []

    def require_match(self) -> Match:
        if self.current_match is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no current match")
        return self.current_match

    async def broadcast(self) -> None:
        if self.current_match is None:
            return
        payload = match_payload(self.current_match)
        disconnected: list[WebSocket] = []
        for websocket in self.websockets:
            try:
                await websocket.send_json(payload)
            except RuntimeError:
                disconnected.append(websocket)
        for websocket in disconnected:
            self.websockets.remove(websocket)


def create_app(
    provider: DecisionProvider | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    app = FastAPI(title="EvoCoup", version="0.1.0")
    settings = settings or Settings()
    if provider is None and settings.openai_api_key is not None:
        provider = OpenAIDecisionProvider(
            api_key=settings.openai_api_key.get_secret_value(),
            model=settings.openai_model,
            reasoning_effort=settings.reasoning_effort,
            timeout_seconds=settings.openai_timeout_seconds,
        )
    runtime = Runtime(provider or MissingAPIKeyProvider())
    app.state.runtime = runtime

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "current_match": runtime.current_match is not None,
            "openai_configured": settings.openai_api_key is not None,
            "model": settings.openai_model,
        }

    @app.post("/api/games")
    async def create_game(request: CreateGameRequest) -> dict[str, Any]:
        runtime.current_match = Match.create(
            request.player_count,
            mode=request.mode,
            provider=runtime.provider,
            seed=request.seed,
        )
        if request.mode is MatchMode.HUMAN_VS_AI:
            await runtime.current_match.advance()
        await runtime.broadcast()
        return match_payload(runtime.current_match)

    @app.get("/api/games/current")
    async def current_game() -> dict[str, Any]:
        return match_payload(runtime.require_match())

    @app.post("/api/games/current/decisions")
    async def submit_decision(request: SubmitDecisionRequest) -> dict[str, Any]:
        match = runtime.require_match()
        try:
            await match.submit_human(
                Decision(
                    request_id=request.request_id,
                    state_version=request.state_version,
                    player_id=request.player_id,
                    option_id=request.option_id,
                )
            )
        except DecisionError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await runtime.broadcast()
        return match_payload(match)

    @app.post("/api/games/current/retry")
    async def retry() -> dict[str, Any]:
        match = runtime.require_match()
        try:
            await match.retry()
        except RuntimeError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await runtime.broadcast()
        return match_payload(match)

    @app.post("/api/games/current/control")
    async def control(request: ControlRequest) -> dict[str, Any]:
        match = runtime.require_match()
        try:
            if request.action == "step":
                await match.step()
            else:
                await match.play()
        except RuntimeError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await runtime.broadcast()
        return match_payload(match)

    @app.get("/api/games/current/debug")
    async def debug() -> dict[str, Any]:
        match = runtime.require_match()
        encoded = jsonable_encoder(
            {
                "game": asdict(match.engine.developer_view()),
                "diagnostics": [asdict(diagnostic) for diagnostic in match.diagnostics],
                "last_error": match.last_error,
            }
        )
        if not isinstance(encoded, dict):
            raise RuntimeError("debug payload did not encode to an object")
        return encoded

    @app.websocket("/api/games/current/events")
    async def events(websocket: WebSocket) -> None:
        await websocket.accept()
        runtime.websockets.append(websocket)
        try:
            if runtime.current_match is not None:
                await websocket.send_json(match_payload(runtime.current_match))
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            runtime.websockets.remove(websocket)

    return app


def match_payload(match: Match) -> dict[str, Any]:
    request = match.pending_request
    if match.human_player_id is not None:
        view: Any = match.engine.seat_view(match.human_player_id)
    else:
        view = match.engine.public_view()
    encoded = jsonable_encoder(
        {
            "mode": match.mode,
            "status": match.status,
            "human_player_id": match.human_player_id,
            "last_error": match.last_error,
            "view": asdict(view),
            "pending_human_decision": (
                asdict(request)
                if request is not None and request.player_id == match.human_player_id
                else None
            ),
        }
    )
    if not isinstance(encoded, dict):
        raise RuntimeError("match payload did not encode to an object")
    return encoded


app = create_app()
