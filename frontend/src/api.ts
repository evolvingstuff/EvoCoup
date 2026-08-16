import type { HealthPayload, MatchMode, MatchPayload } from "./types";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // A non-JSON failure still has a useful HTTP status above.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthPayload>("/api/health"),
  configureOpenAI: (apiKey: string) =>
    request<HealthPayload>("/api/config/openai", {
      method: "POST",
      body: JSON.stringify({ api_key: apiKey }),
    }),
  current: () => request<MatchPayload>("/api/games/current"),
  create: (playerCount: number, mode: MatchMode) =>
    request<MatchPayload>("/api/games", {
      method: "POST",
      body: JSON.stringify({ player_count: playerCount, mode }),
    }),
  decide: (match: MatchPayload, optionId: string) => {
    const decision = match.pending_human_decision;
    if (!decision) throw new Error("There is no human decision to submit.");
    return request<MatchPayload>("/api/games/current/decisions", {
      method: "POST",
      body: JSON.stringify({
        request_id: decision.id,
        state_version: decision.state_version,
        player_id: decision.player_id,
        option_id: optionId,
      }),
    });
  },
  control: (action: "step" | "play") =>
    request<MatchPayload>("/api/games/current/control", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  retry: () => request<MatchPayload>("/api/games/current/retry", { method: "POST" }),
  debug: () => request<Record<string, unknown>>("/api/games/current/debug"),
};
