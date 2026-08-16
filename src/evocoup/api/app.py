"""Local FastAPI application for the current in-memory match."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from evocoup.agents.openai_agent import OpenAIDecisionProvider
from evocoup.api.environment import save_openai_api_key
from evocoup.api.schemas import (
    ConfigureOpenAIRequest,
    ControlRequest,
    CreateGameRequest,
    SubmitDecisionRequest,
)
from evocoup.api.settings import Settings
from evocoup.application.match import Match, MatchMode
from evocoup.application.providers import DecisionProvider, MissingAPIKeyProvider
from evocoup.domain.decisions import Decision, DecisionError

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
IMAGES_DIR = PROJECT_ROOT / "images"


class Runtime:
    def __init__(self, provider: DecisionProvider, *, openai_configured: bool) -> None:
        self.provider = provider
        self.openai_configured = openai_configured
        self.current_match: Match | None = None
        self.websockets: list[WebSocket] = []
        self.agent_memories: dict[str, list[dict[str, Any]]] = {}
        self.session_scores: dict[str, dict[str, int]] = {}
        self._scored_matches: set[int] = set()

    def score_current_match(self) -> None:
        match = self.current_match
        if match is None or id(match) in self._scored_matches:
            return
        public = match.engine.public_view()
        if public.winner_id is None:
            return
        for player in public.players:
            score = self.session_scores.setdefault(player.name, {"games": 0, "wins": 0})
            score["games"] += 1
            if player.id == public.winner_id:
                score["wins"] += 1
        self._scored_matches.add(id(match))

    def archive_current_match(self) -> None:
        """Remember public play and each agent's own private decision snapshots."""

        match = self.current_match
        if match is None:
            return
        public = match.engine.public_view()
        self.score_current_match()
        public_events = [
            {
                "turn": event.turn,
                "type": event.type.value,
                "message": event.message,
                "actor_id": event.actor_id,
                "target_id": event.target_id,
            }
            for event in public.history[-60:]
        ]
        player_names = {player.id: player.name for player in match.engine.state.players}
        for player_id in match.providers:
            agent_name = player_names[player_id]
            private_decisions: list[dict[str, Any]] = []
            for diagnostic in match.diagnostics:
                if (
                    not diagnostic.applied
                    or diagnostic.player_id != player_id
                    or diagnostic.selected_option_id is None
                ):
                    continue
                request_payload = diagnostic.request_payload or {}
                seat_payload = request_payload.get("seat_view", {})
                decision_payload = request_payload.get("decision", {})
                if not isinstance(seat_payload, dict) or not isinstance(decision_payload, dict):
                    continue
                hidden_cards = seat_payload.get("hidden_cards", [])
                held_roles = [
                    str(card.get("role"))
                    for card in hidden_cards
                    if isinstance(card, dict) and card.get("role") is not None
                ]
                options = decision_payload.get("options", [])
                selected = next(
                    (
                        option
                        for option in options
                        if isinstance(option, dict)
                        and option.get("id") == diagnostic.selected_option_id
                    ),
                    {},
                )
                selected_data = selected.get("data", {}) if isinstance(selected, dict) else {}
                claimed_role = _claimed_role(selected_data)
                private_decisions.append(
                    {
                        "turn": _payload_turn(seat_payload),
                        "decision_kind": diagnostic.decision_kind,
                        "choice": selected.get("label", diagnostic.selected_option_id),
                        "held_roles": held_roles,
                        "claimed_role": claimed_role,
                        "knowingly_bluffed": (
                            claimed_role is not None and claimed_role not in held_roles
                        ),
                        "rationale": diagnostic.rationale,
                    }
                )
            memory = {
                "game_number": len(self.agent_memories.get(agent_name, [])) + 1,
                "result": (
                    "won"
                    if public.winner_id == player_id
                    else "lost"
                    if public.winner_id is not None
                    else "unfinished"
                ),
                "turns_reached": public.turn,
                "players": [
                    {"id": player.id, "name": player.name, "seat": player.seat + 1}
                    for player in public.players
                ],
                "public_events": public_events,
                "my_private_decisions": private_decisions[-30:],
            }
            self.agent_memories.setdefault(agent_name, []).append(memory)
            self.agent_memories[agent_name] = self.agent_memories[agent_name][-5:]

    def sync_provider_memory(self, match: Match | None = None) -> None:
        target = match or self.current_match
        player_names = (
            {player.id: player.name for player in target.engine.state.players}
            if target is not None
            else {}
        )
        setter = getattr(self.provider, "set_session_memory", None)
        if callable(setter):
            setter(self.agent_memories, player_names)

    def require_match(self) -> Match:
        if self.current_match is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no current match")
        return self.current_match

    async def broadcast(self) -> None:
        if self.current_match is None:
            return
        self.score_current_match()
        payload = match_payload(self.current_match, self.session_scores)
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
    env_path: Path | None = None,
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
    runtime = Runtime(
        provider or MissingAPIKeyProvider(),
        openai_configured=settings.openai_api_key is not None,
    )
    env_path = env_path or PROJECT_ROOT / ".env"
    app.state.runtime = runtime

    def health_payload() -> dict[str, Any]:
        return {
            "status": "ok",
            "current_match": runtime.current_match is not None,
            "openai_configured": runtime.openai_configured,
            "model": settings.openai_model,
        }

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return health_payload()

    @app.post("/api/config/openai")
    async def configure_openai(request: ConfigureOpenAIRequest) -> dict[str, Any]:
        api_key = request.api_key.get_secret_value()
        try:
            save_openai_api_key(env_path, api_key)
        except (OSError, ValueError) as error:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="could not save the OpenAI API key to .env",
            ) from error
        configured_provider = OpenAIDecisionProvider(
            api_key=api_key,
            model=settings.openai_model,
            reasoning_effort=settings.reasoning_effort,
            timeout_seconds=settings.openai_timeout_seconds,
        )
        runtime.provider = configured_provider
        runtime.openai_configured = True
        runtime.sync_provider_memory()
        if runtime.current_match is not None:
            for player_id in runtime.current_match.providers:
                runtime.current_match.providers[player_id] = configured_provider
        return health_payload()

    @app.post("/api/games")
    async def create_game(request: CreateGameRequest) -> dict[str, Any]:
        runtime.archive_current_match()
        runtime.current_match = Match.create(
            request.player_count,
            mode=request.mode,
            provider=runtime.provider,
            seed=request.seed,
        )
        runtime.sync_provider_memory(runtime.current_match)
        if request.mode is MatchMode.HUMAN_VS_AI:
            await runtime.current_match.advance()
        await runtime.broadcast()
        return match_payload(runtime.current_match, runtime.session_scores)

    @app.get("/api/games/current")
    async def current_game() -> dict[str, Any]:
        return match_payload(runtime.require_match(), runtime.session_scores)

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
        return match_payload(match, runtime.session_scores)

    @app.post("/api/games/current/retry")
    async def retry() -> dict[str, Any]:
        match = runtime.require_match()
        try:
            await match.retry()
        except RuntimeError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await runtime.broadcast()
        return match_payload(match, runtime.session_scores)

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
        return match_payload(match, runtime.session_scores)

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
                await websocket.send_json(
                    match_payload(runtime.current_match, runtime.session_scores)
                )
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            runtime.websockets.remove(websocket)

    app.mount("/images", StaticFiles(directory=IMAGES_DIR), name="images")
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets", check_dir=False),
        name="frontend-assets",
    )

    @app.get("/{frontend_path:path}", include_in_schema=False)
    async def frontend(frontend_path: str) -> Response:
        """Serve the built single-page app without masking API routes."""

        if frontend_path.startswith("api/"):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
        index = FRONTEND_DIST / "index.html"
        if index.is_file():
            return FileResponse(index)
        return HTMLResponse(
            "EvoCoup's frontend has not been built. Run `npm install` and "
            "`npm run build` in frontend/.",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    return app


def _payload_turn(seat_payload: dict[str, Any]) -> int | None:
    public = seat_payload.get("public", {})
    if not isinstance(public, dict):
        return None
    turn = public.get("turn")
    return turn if isinstance(turn, int) else None


def _claimed_role(selected_data: object) -> str | None:
    if not isinstance(selected_data, dict):
        return None
    role = selected_data.get("role")
    if isinstance(role, str):
        return role
    action = selected_data.get("action")
    if not isinstance(action, str):
        return None
    return {
        "tax": "duke",
        "assassinate": "assassin",
        "steal": "captain",
        "exchange": "ambassador",
    }.get(action)


def match_payload(
    match: Match,
    standings: dict[str, dict[str, int]] | None = None,
) -> dict[str, Any]:
    request = match.pending_request
    thinking_requests = match.thinking_requests if match.status.value == "running" else ()
    if (
        not thinking_requests
        and request is not None
        and request.player_id != match.human_player_id
        and match.status.value == "running"
    ):
        thinking_requests = (request,)
    thinking_request = thinking_requests[0] if thinking_requests else None
    if match.human_player_id is not None:
        view: Any = match.engine.seat_view(match.human_player_id)
    else:
        view = match.engine.public_view()
    encoded = jsonable_encoder(
        {
            "mode": match.mode,
            "status": match.status,
            "human_player_id": match.human_player_id,
            "thinking_player_id": (
                thinking_request.player_id if thinking_request is not None else None
            ),
            "thinking_decision_kind": (
                thinking_request.kind.value if thinking_request is not None else None
            ),
            "thinking_players": [
                {
                    "player_id": active_request.player_id,
                    "decision_kind": active_request.kind.value,
                }
                for active_request in thinking_requests
            ],
            "standings": [{"name": name, **score} for name, score in (standings or {}).items()],
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
