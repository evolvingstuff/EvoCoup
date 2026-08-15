"""Decision-provider boundary used by match orchestration."""

from dataclasses import dataclass, field
from typing import Any, Protocol

from evocoup.domain.decisions import DecisionRequest
from evocoup.domain.views import SeatGameView


@dataclass(frozen=True, slots=True)
class ProviderDecision:
    option_id: str
    rationale: str
    model: str | None = None
    usage: dict[str, Any] | None = None
    raw_response: dict[str, Any] | None = None
    request_payload: dict[str, Any] = field(default_factory=dict)


class DecisionProvider(Protocol):
    async def decide(self, request: DecisionRequest, view: SeatGameView) -> ProviderDecision:
        """Return exactly one option ID plus sanitized diagnostics."""


class FirstLegalProvider:
    """Deterministic provider for tests and local API development."""

    async def decide(self, request: DecisionRequest, view: SeatGameView) -> ProviderDecision:
        del view
        return ProviderDecision(
            option_id=request.options[0].id,
            rationale="Selected the first legal option for deterministic testing.",
            model="first-legal-test-provider",
        )


class MissingAPIKeyProvider:
    async def decide(self, request: DecisionRequest, view: SeatGameView) -> ProviderDecision:
        del request, view
        raise RuntimeError("OPENAI_API_KEY is not configured")
