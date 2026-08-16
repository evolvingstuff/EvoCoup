"""OpenAI Responses API implementation of the decision-provider boundary."""

import json
from copy import deepcopy
from dataclasses import asdict
from typing import Any, Literal, cast

from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field

from evocoup.agents.prompts import PROMPT_VERSION, SYSTEM_PROMPT
from evocoup.application.providers import ProviderDecision
from evocoup.domain.decisions import DecisionRequest
from evocoup.domain.views import SeatGameView


class AgentDecisionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    choice_id: str
    rationale: str = Field(min_length=1, max_length=280)


class OpenAIDecisionProvider:
    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gpt-5.6-terra",
        reasoning_effort: Literal["none", "low", "medium", "high", "xhigh"] = "low",
        timeout_seconds: float = 90,
        client: Any | None = None,
    ) -> None:
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.timeout_seconds = timeout_seconds
        self._client: Any = client or AsyncOpenAI(api_key=api_key, timeout=timeout_seconds)
        self._session_memory: dict[str, list[dict[str, Any]]] = {}
        self._player_names: dict[str, str] = {}

    def set_session_memory(
        self,
        memories: dict[str, list[dict[str, Any]]],
        player_names: dict[str, str],
    ) -> None:
        """Install server-session memories without sharing private data between agents."""

        self._session_memory = deepcopy(memories)
        self._player_names = dict(player_names)

    async def decide(
        self,
        request: DecisionRequest,
        view: SeatGameView,
    ) -> ProviderDecision:
        agent_name = self._player_names.get(request.player_id)
        request_payload = {
            "prompt_version": PROMPT_VERSION,
            "agent_identity": agent_name,
            "prior_court_memory": deepcopy(self._session_memory.get(agent_name or "", [])),
            "seat_view": asdict(view),
            "decision": asdict(request),
        }
        response = await self._client.responses.parse(
            model=self.model,
            reasoning={"effort": self.reasoning_effort},
            instructions=SYSTEM_PROMPT,
            input=json.dumps(request_payload, default=str, separators=(",", ":")),
            text_format=AgentDecisionOutput,
            store=False,
            timeout=self.timeout_seconds,
        )
        parsed = response.output_parsed
        if parsed is None:
            raise ValueError("OpenAI response did not contain a parsed decision")
        if not isinstance(parsed, AgentDecisionOutput):
            raise TypeError("OpenAI response parsed to an unexpected type")

        raw_response = cast(dict[str, Any], response.model_dump(mode="json"))
        usage = (
            cast(dict[str, Any], response.usage.model_dump(mode="json"))
            if response.usage is not None
            else None
        )
        return ProviderDecision(
            option_id=parsed.choice_id,
            rationale=parsed.rationale,
            model=str(response.model),
            usage=usage,
            raw_response=raw_response,
            request_payload=request_payload,
        )
