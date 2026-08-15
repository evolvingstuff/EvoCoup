from fastapi.testclient import TestClient

from evocoup.api.app import create_app
from evocoup.application.providers import FirstLegalProvider


def client() -> TestClient:
    return TestClient(create_app(FirstLegalProvider()))


def test_health_and_missing_match() -> None:
    with client() as test_client:
        assert test_client.get("/api/health").json() == {
            "status": "ok",
            "current_match": False,
            "openai_configured": False,
            "model": "gpt-5.6-terra",
        }
        assert test_client.get("/api/games/current").status_code == 404


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
