from pathlib import Path

from fastapi.testclient import TestClient

from evocoup.api.app import create_app
from evocoup.api.settings import Settings
from evocoup.application.providers import FirstLegalProvider


def isolated_settings() -> Settings:
    return Settings.model_construct(
        openai_api_key=None,
        openai_model="gpt-5.6-terra",
        reasoning_effort="low",
        openai_timeout_seconds=90,
    )


def client() -> TestClient:
    return TestClient(create_app(FirstLegalProvider(), settings=isolated_settings()))


def test_health_and_missing_match() -> None:
    with client() as test_client:
        assert test_client.get("/api/health").json() == {
            "status": "ok",
            "current_match": False,
            "openai_configured": False,
            "model": "gpt-5.6-terra",
        }
        assert test_client.get("/api/games/current").status_code == 404


def test_root_explains_how_to_build_frontend_when_bundle_is_absent() -> None:
    with client() as test_client:
        response = test_client.get("/")

        assert response.status_code in {200, 503}
        if response.status_code == 503:
            assert "npm run build" in response.text


def test_unknown_api_route_is_not_masked_by_frontend() -> None:
    with client() as test_client:
        response = test_client.get("/api/not-a-route")

        assert response.status_code == 404
        assert response.json() == {"detail": "not found"}


def test_configure_openai_saves_key_without_returning_it_and_updates_match(
    tmp_path: Path,
) -> None:
    env_path = tmp_path / ".env"
    app = create_app(
        FirstLegalProvider(),
        settings=isolated_settings(),
        env_path=env_path,
    )
    api_key = "sk-test_key_that_is_safely_long_enough"
    with TestClient(app) as test_client:
        test_client.post(
            "/api/games",
            json={"player_count": 3, "mode": "ai_only", "seed": 9},
        )
        match = app.state.runtime.current_match
        assert match is not None
        old_providers = tuple(match.providers.values())

        response = test_client.post("/api/config/openai", json={"api_key": api_key})

        assert response.status_code == 200
        assert response.json()["openai_configured"] is True
        assert api_key not in response.text
        assert env_path.read_text(encoding="utf-8") == f"OPENAI_API_KEY={api_key}\n"
        new_providers = tuple(match.providers.values())
        assert all(provider is app.state.runtime.provider for provider in new_providers)
        assert all(
            provider is not old for provider, old in zip(new_providers, old_providers, strict=True)
        )


def test_configure_openai_rejects_invalid_key_without_creating_env(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    with TestClient(
        create_app(
            FirstLegalProvider(),
            settings=isolated_settings(),
            env_path=env_path,
        )
    ) as test_client:
        response = test_client.post("/api/config/openai", json={"api_key": "not-a-key"})

    assert response.status_code == 422
    assert not env_path.exists()


def test_create_human_match_returns_private_human_view_and_prompt() -> None:
    with client() as test_client:
        response = test_client.post(
            "/api/games",
            json={"player_count": 3, "mode": "human_vs_ai", "seed": 1},
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "waiting_for_human"
        assert payload["human_player_id"] == "player-1"
        assert payload["thinking_player_id"] is None
        assert payload["thinking_decision_kind"] is None
        assert payload["thinking_players"] == []
        assert payload["standings"] == []
        assert len(payload["view"]["hidden_cards"]) == 2
        assert payload["pending_human_decision"]["player_id"] == "player-1"


def test_submit_human_decision_and_reject_stale_replay() -> None:
    with client() as test_client:
        created = test_client.post(
            "/api/games",
            json={"player_count": 3, "mode": "human_vs_ai", "seed": 2},
        ).json()
        request = created["pending_human_decision"]
        body = {
            "request_id": request["id"],
            "state_version": request["state_version"],
            "player_id": request["player_id"],
            "option_id": request["options"][0]["id"],
        }

        accepted = test_client.post("/api/games/current/decisions", json=body)
        rejected = test_client.post("/api/games/current/decisions", json=body)

        assert accepted.status_code == 200
        assert rejected.status_code == 409


def test_ai_only_step_and_debug_diagnostics() -> None:
    with client() as test_client:
        created = test_client.post(
            "/api/games",
            json={"player_count": 3, "mode": "ai_only", "seed": 3},
        ).json()
        assert created["status"] == "paused"
        assert created["view"]["version"] == 0

        stepped = test_client.post(
            "/api/games/current/control",
            json={"action": "step"},
        ).json()
        debug = test_client.get("/api/games/current/debug").json()

        assert stepped["status"] == "paused"
        assert stepped["view"]["version"] == 1
        assert len(debug["diagnostics"]) == 1


def test_websocket_receives_current_snapshot() -> None:
    with client() as test_client:
        test_client.post(
            "/api/games",
            json={"player_count": 3, "mode": "ai_only", "seed": 4},
        )
        with test_client.websocket_connect("/api/games/current/events") as websocket:
            payload = websocket.receive_json()

        assert payload["mode"] == "ai_only"
        assert payload["status"] == "paused"
