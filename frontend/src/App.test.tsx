import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { MatchPayload, PublicGameView } from "./types";

const health = {
  status: "ok",
  current_match: false,
  openai_configured: true,
  model: "test-model",
};

const spectatorMatch: MatchPayload = {
  mode: "ai_only",
  status: "paused",
  human_player_id: null,
  thinking_player_id: null,
  thinking_decision_kind: null,
  thinking_players: [],
  standings: [],
  last_error: null,
  pending_human_decision: null,
  view: {
    game_id: "current",
    version: 0,
    turn: 1,
    phase: "await_action",
    active_player_id: "player-1",
    starting_player_id: "player-1",
    players: [
      {
        id: "player-1",
        name: "Agent 1",
        seat: 0,
        coins: 2,
        hidden_influence_count: 2,
        revealed_roles: [],
        is_alive: true,
      },
      {
        id: "player-2",
        name: "Agent 2",
        seat: 1,
        coins: 2,
        hidden_influence_count: 2,
        revealed_roles: [],
        is_alive: true,
      },
    ],
    court_deck_count: 3,
    treasury: 45,
    pending_action: null,
    pending_block: null,
    pending_challenge: null,
    winner_id: null,
    history: [],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EvoCoup app", () => {
  it("opens on a game-first setup screen", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/health") return Promise.resolve(jsonResponse(health));
      return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Trust no one." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Enter the court" })).toBeEnabled();
    expect(screen.getByText("Faithful base rules")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/games/current");
  });

  it("creates an AI-only table from the setup controls", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/health") return Promise.resolve(jsonResponse(health));
      if (path === "/api/games/current") {
        return Promise.resolve(jsonResponse({ detail: "no current match" }, 404));
      }
      if (path === "/api/games" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(spectatorMatch));
      }
      if (path === "/api/games/current/control" && init?.method === "POST") {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Observe Watch agents scheme" }));
    await user.click(screen.getByRole("button", { name: "2 players" }));
    await user.click(screen.getByRole("button", { name: "Enter the court" }));

    expect(await screen.findByText("The court deliberates")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "› Step" })).toBeNull();
    expect(screen.queryByRole("button", { name: "1x" })).toBeNull();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) =>
      String(input) === "/api/games/current/control"
    )).toBe(true));
    const createCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/games");
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      player_count: 2,
      mode: "ai_only",
    });
  });

  it("pauses and resumes an all-agent court", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/health") return Promise.resolve(jsonResponse(health));
      if (path === "/api/games" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(spectatorMatch));
      }
      if (path === "/api/games/current/control" && init?.method === "POST") {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Observe Watch agents scheme" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("The court is paused")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === "/api/games/current/control"
    )).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === "/api/games/current/control"
    )).toHaveLength(1);
  });

  it("does not advance autoplay until every current result has finished", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const resolvedMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 4,
        turn: 2,
        active_player_id: "player-2",
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Steal as Captain targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal", claimed_role: "captain" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "response_passed",
            message: "Agent 2 passed on the action challenge.",
            actor_id: "player-2",
            target_id: null,
            details: { window: "the action challenge" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "response_passed",
            message: "Agent 2 passed on the block opportunity.",
            actor_id: "player-2",
            target_id: null,
            details: { window: "the block opportunity" },
          },
          {
            sequence: 4,
            turn: 1,
            type: "action_resolved",
            message: "Agent 1 stole 2 coins from Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal" },
          },
        ],
      },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/health") return Promise.resolve(jsonResponse(health));
      if (path === "/api/games" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(resolvedMatch));
      }
      if (path === "/api/games/current/control" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(resolvedMatch));
      }
      return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const controlCalls = () => fetchMock.mock.calls.filter(([input]) =>
      String(input) === "/api/games/current/control"
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(document.querySelector(".game-shell")).toHaveClass("game-shell--paused");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole("status", { name: "Action result: No challenges" })).toBeVisible();
    expect(controlCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1099); });
    expect(screen.getByRole("status", { name: "Action result: No challenges" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    for (let resultIndex = 1; resultIndex < 3; resultIndex += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2099); });
      expect(controlCalls()).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByRole("status", { name: /Action result:/ })).toBeNull();
    expect(controlCalls()).toHaveLength(1);
  });

  it("explains when an agent is choosing cards for Exchange", async () => {
    const exchangeMatch: MatchPayload = {
      ...spectatorMatch,
      status: "running",
      thinking_player_id: "player-1",
      thinking_decision_kind: "exchange",
      thinking_players: [{ player_id: "player-1", decision_kind: "exchange" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(exchangeMatch));
        }
        if (path === "/api/games/current") {
          return Promise.resolve(jsonResponse(exchangeMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByLabelText("Seat 01: choosing cards…")).toBeVisible();
  });

  it("shows all agents thinking in a parallel response window", async () => {
    const parallelMatch: MatchPayload = {
      ...spectatorMatch,
      status: "running",
      thinking_player_id: "player-1",
      thinking_decision_kind: "action_challenge",
      thinking_players: [
        { player_id: "player-1", decision_kind: "action_challenge" },
        { player_id: "player-2", decision_kind: "action_challenge" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(parallelMatch));
        }
        if (path === "/api/games/current") {
          return Promise.resolve(jsonResponse(parallelMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Seat 01: thinking of challenging…")).toBeVisible();
    expect(screen.getByLabelText("Seat 02: thinking of challenging…")).toBeVisible();
  });

  it("explains when a running match disappears after a server restart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(spectatorMatch));
        }
        if (path === "/api/games/current") {
          return Promise.resolve(jsonResponse({ detail: "no current match" }, 404));
        }
        if (path === "/api/games/current/control" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ detail: "no current match" }, 404));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Observe Watch agents scheme" }));
    await user.click(screen.getByRole("button", { name: "Enter the court" }));

    expect(await screen.findByRole("heading", { name: "Trust no one." })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Game interrupted" })).toHaveTextContent(
      "The local server restarted and its in-memory game was cleared.",
    );
  });

  it("prompts for a missing API key and sends it only to the local configuration route", async () => {
    const apiKey = "sk-test_key_that_is_safely_long_enough";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/health") {
        return Promise.resolve(jsonResponse({ ...health, openai_configured: false }));
      }
      if (path === "/api/games/current") {
        return Promise.resolve(jsonResponse({ detail: "no current match" }, 404));
      }
      if (path === "/api/config/openai" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(health));
      }
      return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("dialog", { name: "Configure OpenAI" })).toBeVisible();
    await user.type(screen.getByLabelText("OpenAI API key"), apiKey);
    await user.click(screen.getByRole("button", { name: "Save key and continue" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure OpenAI" })).toBeNull());
    const configureCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/config/openai",
    );
    expect(configureCall).toBeDefined();
    expect(JSON.parse(String(configureCall?.[1]?.body))).toEqual({ api_key: apiKey });
  });

  it("shows a stopped agent call as a dismissible modal", async () => {
    const failure = "RateLimitError: credit balance exhausted";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({
            ...spectatorMatch,
            status: "agent_error",
            last_error: failure,
          }));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    const dialog = await screen.findByRole("dialog", { name: "Agent call failed" });
    expect(dialog).toHaveTextContent(failure);
    await user.click(screen.getByRole("button", { name: "Close error" }));
    expect(screen.queryByRole("dialog", { name: "Agent call failed" })).toBeNull();
  });

  it("labels basic, card-backed, and bluff actions from the human hand", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const actionDecision = {
      id: "choose-action",
      state_version: 1,
      player_id: "player-1",
      kind: "action",
      prompt: "Choose your action.",
      options: [
        { id: "income", label: "Income", data: { action: "income" } },
        { id: "tax", label: "Tax", data: { action: "tax" } },
        { id: "steal", label: "Steal — Agent 2", data: { action: "steal" } },
      ],
    };
    const actionMatch: MatchPayload = {
      ...spectatorMatch,
      mode: "human_vs_ai",
      status: "waiting_for_human",
      human_player_id: "player-1",
      pending_human_decision: actionDecision,
      view: {
        public: {
          ...publicView,
          players: publicView.players.map((player, index) =>
            index === 0 ? { ...player, name: "You" } : player,
          ),
        },
        player_id: "player-1",
        hidden_cards: [
          { id: "assassin-card", role: "assassin" },
          { id: "captain-card", role: "captain" },
        ],
        known_setup_discards: [],
        setup_choices: [],
        exchange_cards: [],
        pending_decision: actionDecision,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(actionMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByText("Income").closest("button")?.querySelector(".action-provenance")).toBeNull();
    const bluffCard = screen.getByLabelText("Bluff — you do not hold the Duke this action claims.");
    expect(bluffCard).toHaveClass("action-provenance--bluff");
    expect(bluffCard.querySelector("img")).toHaveAttribute("src", "/images/cards/duke.png");
    const heldCard = screen.getByLabelText("Card-backed claim — you hold the required Captain.");
    expect(heldCard).toHaveClass("action-provenance--card");
    expect(heldCard.querySelector("img")).toHaveAttribute("src", "/images/cards/captain.png");
    const taxAction = screen.getByTitle(/Claim Duke and take 3 coins/);
    await user.hover(taxAction);
    expect(screen.getByText("Tax")).toBeVisible();
    expect(screen.getByText(/The claim may be challenged/)).toBeVisible();
    const stealAction = screen.getByTitle(/Claim Captain and take up to 2 coins/);
    const captainCard = screen.getByAltText("Captain").closest("figure");
    await user.hover(stealAction);
    expect(captainCard).toHaveClass("role-card--highlighted");
    await user.unhover(stealAction);
    expect(captainCard).not.toHaveClass("role-card--highlighted");
  });

  it("does not present the human as eliminated during two-player setup", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const setupDecision = {
      id: "setup-card",
      state_version: 0,
      player_id: "player-1",
      kind: "setup_card",
      prompt: "Choose one character from your private five-card set.",
      options: [{ id: "choose-duke", label: "Keep Duke", data: { role: "duke" } }],
    };
    const setupMatch: MatchPayload = {
      ...spectatorMatch,
      mode: "human_vs_ai",
      status: "waiting_for_human",
      human_player_id: "player-1",
      pending_human_decision: setupDecision,
      view: {
        public: {
          ...publicView,
          phase: "setup_selection",
          players: publicView.players.map((player, index) => ({
            ...player,
            name: index === 0 ? "You" : player.name,
            hidden_influence_count: 0,
            is_alive: true,
          })),
        },
        player_id: "player-1",
        hidden_cards: [],
        known_setup_discards: [],
        setup_choices: [{ id: "duke-choice", role: "duke" }],
        exchange_cards: [],
        pending_decision: setupDecision,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(setupMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByText("Choose your first influence in the right column")).toBeVisible();
    expect(screen.queryByText("You have been eliminated")).toBeNull();
  });

  it("marks unavailable block roles as red bluffs", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const blockDecision = {
      id: "block-steal",
      state_version: 4,
      player_id: "player-1",
      kind: "block",
      prompt: "Block the pending action?",
      options: [
        { id: "block:pass", label: "Do not block", data: {} },
        { id: "block:captain", label: "Block as Captain", data: { role: "captain" } },
        { id: "block:ambassador", label: "Block as Ambassador", data: { role: "ambassador" } },
      ],
    };
    const blockMatch: MatchPayload = {
      ...spectatorMatch,
      mode: "human_vs_ai",
      status: "waiting_for_human",
      human_player_id: "player-1",
      pending_human_decision: blockDecision,
      view: {
        public: {
          ...publicView,
          phase: "block_window",
          players: publicView.players.map((player, index) =>
            index === 0 ? { ...player, name: "You" } : player,
          ),
          pending_action: {
            actor_id: "player-2",
            action: "steal",
            target_id: "player-1",
            claimed_role: "captain",
          },
        },
        player_id: "player-1",
        hidden_cards: [
          { id: "assassin-card", role: "assassin" },
          { id: "contessa-card", role: "contessa" },
        ],
        known_setup_discards: [],
        setup_choices: [],
        exchange_cards: [],
        pending_decision: blockDecision,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(blockMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByRole("heading", { name: /Seat 02 is trying to steal.*from you/ })).toBeVisible();
    const claimCard = screen.getByLabelText(/Seat 02 claims Captain for Steal against You/);
    expect(claimCard).toBeVisible();
    await user.hover(claimCard);
    expect(claimCard.querySelector(".board-role-tooltip")).toHaveTextContent(
      "Steal: take up to 2 coins from a target. May also block Steal.",
    );
    expect(screen.getByRole("img", { name: "Steal from Seat 02 to You" })).toBeVisible();
    expect(document.querySelector(".action-thread__label")).toHaveTextContent("Steal");
    expect(screen.getByLabelText(/Bluff.*Captain/)).toHaveClass("decision-option__cards--bluff");
    expect(screen.getByLabelText(/Bluff.*Ambassador/)).toHaveClass("decision-option__cards--bluff");
    expect(screen.getByText("Red card: Bluff")).toBeVisible();
  });

  it("puts an influence-loss consequence before the instruction", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const lossDecision = {
      id: "lose-influence",
      state_version: 8,
      player_id: "player-1",
      kind: "lose_influence",
      prompt: "You lost a challenge against Agent 2. Choose an influence to reveal.",
      options: [
        { id: "reveal-assassin", label: "Reveal Assassin", data: { role: "assassin" } },
        { id: "reveal-contessa", label: "Reveal Contessa", data: { role: "contessa" } },
      ],
    };
    const lossMatch: MatchPayload = {
      ...spectatorMatch,
      mode: "human_vs_ai",
      status: "waiting_for_human",
      human_player_id: "player-1",
      pending_human_decision: lossDecision,
      view: {
        public: {
          ...publicView,
          players: publicView.players.map((player, index) =>
            index === 0 ? { ...player, name: "You" } : player,
          ),
          phase: "influence_loss",
          history: [
            {
              sequence: 1,
              turn: 1,
              type: "action_declared",
              message: "You declared Steal as Captain targeting Agent 2.",
              actor_id: "player-1",
              target_id: "player-2",
              details: { action: "steal", claimed_role: "captain" },
            },
            {
              sequence: 2,
              turn: 1,
              type: "block_declared",
              message: "Agent 2 blocked Steal as Captain.",
              actor_id: "player-2",
              target_id: "player-1",
              details: { role: "captain" },
            },
            {
              sequence: 3,
              turn: 1,
              type: "challenge_declared",
              message: "You challenged the block made by Agent 2.",
              actor_id: "player-1",
              target_id: "player-2",
              details: { claim_kind: "block" },
            },
            {
              sequence: 4,
              turn: 1,
              type: "claim_proven",
              message: "Agent 2 proved the Captain claim.",
              actor_id: "player-2",
              target_id: "player-1",
              details: { role: "captain" },
            },
          ],
        },
        player_id: "player-1",
        hidden_cards: [
          { id: "assassin-card", role: "assassin" },
          { id: "contessa-card", role: "contessa" },
        ],
        known_setup_discards: [],
        setup_choices: [],
        exchange_cards: [],
        pending_decision: lossDecision,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(lossMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const warning = screen.getByText("You lost a challenge against Seat 02.");
    const instruction = screen.getByRole("heading", { name: "Choose an influence to reveal." });
    expect(warning).toHaveClass("decision-consequence");
    expect(warning.compareDocumentPosition(instruction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText("Negative action outcome for You")).toBeNull();
    expect(screen.queryByLabelText("Positive action outcome for Seat 02")).toBeNull();
    expect(screen.getByLabelText("You: 2 coins, 2 hidden influence"))
      .toHaveClass("player-seat--challenging");
    expect(document.querySelector(".seat-response-indicator--challenging")).toBeNull();
    expect(screen.getByRole("img", { name: "Challenge from You to Seat 02" }))
      .toHaveClass("response-thread--concluding");
    expect(screen.getByRole("img", { name: "Steal from You to Seat 02" }))
      .toHaveClass("action-thread--subdued");
    const blockCard = screen.getByLabelText("Seat 02 is blocking as Captain");
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to You" }))
      .toHaveClass("response-thread--subdued");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.queryByRole("img", { name: "Challenge from You to Seat 02" })).toBeNull();
    expect(screen.getByRole("img", { name: "Steal from You to Seat 02" }))
      .toHaveClass("action-thread--resumed", "action-thread--subdued");
    const survivingBlock = screen.getByRole("img", { name: "Blocking from Seat 02 to You" });
    expect(survivingBlock).toHaveClass("response-thread--resumed");
    expect(survivingBlock).not.toHaveClass("response-thread--subdued");
    expect(screen.getByLabelText("Seat 02 is blocking as Captain")).toBe(blockCard);
  });

  it("stacks unresolved actions beneath the newest response path", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const responseMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        phase: "claim_response",
        pending_action: {
          actor_id: "player-1",
          action: "steal",
          target_id: "player-2",
          claimed_role: "captain",
        },
        pending_block: { blocker_id: "player-2", claimed_role: "captain" },
        pending_challenge: {
          claimant_id: "player-2",
          challenger_id: "player-1",
          role: "captain",
          claim_kind: "block",
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(responseMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByLabelText("Seat 02 is blocking as Captain")).toBeVisible();
    expect(screen.getByLabelText("Agent 1: 2 coins, 2 hidden influence"))
      .toHaveClass("player-seat--challenging");
    expect(container.querySelector(".seat-response-indicator--challenging")).toBeNull();
    expect(screen.getByRole("img", { name: "Steal from Seat 01 to Seat 02" }))
      .toHaveClass("action-thread--subdued");
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to Seat 01" }))
      .toHaveClass("response-thread--subdued");
    expect(screen.getByRole("img", { name: "Challenge from Seat 01 to Seat 02" })).toBeVisible();
    expect(container.querySelector(".response-thread__label--challenge"))
      .toHaveTextContent("Challenge");
    expect(container.querySelectorAll(".action-thread, .response-thread")).toHaveLength(3);
  });

  it("shows a red loss marker when a failed challenge costs influence", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const resolvedLossMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 4,
        phase: "block_window",
        pending_action: {
          actor_id: "player-1",
          action: "tax",
          target_id: null,
          claimed_role: "duke",
        },
        players: publicView.players.map((player) =>
          player.id === "player-2"
            ? { ...player, hidden_influence_count: 1, revealed_roles: ["captain"] }
            : player,
        ),
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Tax as Duke.",
            actor_id: "player-1",
            target_id: null,
            details: { action: "tax", claimed_role: "duke" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "challenge_declared",
            message: "Agent 2 challenged the claim made by Agent 1.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { claim_kind: "action" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "claim_proven",
            message: "Agent 1 proved the Duke claim.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { role: "duke" },
          },
          {
            sequence: 4,
            turn: 1,
            type: "influence_lost",
            message: "Agent 2 revealed Captain and lost an influence.",
            actor_id: "player-2",
            target_id: null,
            details: { role: "captain", card_id: "captain-1" },
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(resolvedLossMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status", { name: "Action result: Action challenge failed" }))
      .toBeVisible();
    expect(screen.queryByLabelText("Negative action outcome for Seat 02")).toBeNull();
    expect(screen.queryByAltText("Revealed Captain")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole("status", { name: "Action result: Seat 02 revealed Captain" }))
      .toBeVisible();
    expect(screen.getByRole("img", { name: "Seat 02 reveals Captain" })).toBeVisible();
    expect(screen.queryByLabelText("Negative action outcome for Seat 02")).toBeNull();
    expect(screen.queryByAltText("Revealed Captain")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole("status", { name: "Action result: Seat 02 lost an influence" }))
      .toBeVisible();
    expect(screen.getByLabelText("Negative action outcome for Seat 02")).toBeVisible();
    const revealedCard = screen.getByAltText("Revealed Captain");
    const seat = screen.getByLabelText("Agent 2: 2 coins, 1 hidden influence");
    expect(revealedCard).toBeVisible();
    expect(seat).toContainElement(revealedCard);
    expect(revealedCard.closest(".player-seat__body")).not.toBeNull();
    expect(revealedCard.closest(".revealed-influence-row"))
      .toHaveClass("revealed-influence-row");
  });

  it("finishes an assassination before highlighting the next turn", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const thirdPlayer = {
      id: "player-3",
      name: "Agent 3",
      seat: 2,
      coins: 2,
      hidden_influence_count: 2,
      revealed_roles: [] as PublicGameView["players"][number]["revealed_roles"],
      is_alive: true,
    };
    const assassinationMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 5,
        turn: 2,
        phase: "await_action",
        active_player_id: "player-3",
        players: [
          publicView.players[0],
          {
            ...publicView.players[1],
            hidden_influence_count: 0,
            revealed_roles: ["captain", "contessa"],
            is_alive: false,
          },
          thirdPlayer,
        ],
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Assassinate as Assassin targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "assassinate", claimed_role: "assassin" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "influence_lost",
            message: "Agent 2 revealed Contessa and lost an influence.",
            actor_id: "player-2",
            target_id: null,
            details: { role: "contessa", card_id: "contessa-1" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "player_eliminated",
            message: "Agent 2 was eliminated and returned 2 coins.",
            actor_id: "player-2",
            target_id: null,
            details: { returned_coins: 2 },
          },
          {
            sequence: 4,
            turn: 1,
            type: "turn_ended",
            message: "Agent 1's turn ended.",
            actor_id: "player-1",
            target_id: null,
            details: {},
          },
          {
            sequence: 5,
            turn: 2,
            type: "turn_started",
            message: "Turn 2: Agent 3 acts.",
            actor_id: "player-3",
            target_id: null,
            details: {},
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(assassinationMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status", { name: "Action result: Seat 02 revealed Contessa" }))
      .toBeVisible();
    expect(screen.getByRole("img", { name: "Seat 02 reveals Contessa" })).toBeVisible();
    expect(screen.getByLabelText("Agent 1: 2 coins, 2 hidden influence"))
      .toHaveClass("player-seat--active");
    expect(screen.getByLabelText("Agent 3: 2 coins, 2 hidden influence"))
      .not.toHaveClass("player-seat--active");
    expect(screen.getByRole("img", { name: /Assassinate from Seat 01/ }))
      .not.toHaveClass("action-thread--concluding");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole("status", { name: "Action result: Seat 02 has died" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "Seat 02 reveals Contessa" })).toBeNull();
    expect(screen.getByRole("img", { name: /Assassinate from Seat 01/ }))
      .toHaveClass("action-thread--concluding");
    expect(screen.getByLabelText("Agent 3: 2 coins, 2 hidden influence"))
      .not.toHaveClass("player-seat--active");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.queryByRole("img", { name: /Assassinate from Seat 01/ })).toBeNull();
    expect(screen.getByLabelText("Agent 3: 2 coins, 2 hidden influence"))
      .toHaveClass("player-seat--active");
  });

  it("clears a proven terminal block instead of resurrecting it after game over", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const finishedMatch: MatchPayload = {
      ...spectatorMatch,
      status: "finished",
      view: {
        ...publicView,
        version: 8,
        turn: 1,
        phase: "finished",
        active_player_id: "player-1",
        winner_id: "player-2",
        players: [
          {
            ...publicView.players[0],
            coins: 0,
            hidden_influence_count: 0,
            revealed_roles: ["assassin", "contessa"],
            is_alive: false,
          },
          publicView.players[1],
        ],
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Assassinate as Assassin targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "assassinate", claimed_role: "assassin" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "block_declared",
            message: "Agent 2 claimed Contessa to block Assassinate.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { role: "contessa", action: "assassinate" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "challenge_declared",
            message: "Agent 1 challenged the block made by Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { claim_kind: "block" },
          },
          {
            sequence: 4,
            turn: 1,
            type: "claim_proven",
            message: "Agent 2 proved the Contessa claim.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { role: "contessa" },
          },
          {
            sequence: 5,
            turn: 1,
            type: "influence_lost",
            message: "Agent 1 revealed Contessa and lost an influence.",
            actor_id: "player-1",
            target_id: null,
            details: { role: "contessa", card_id: "contessa-1" },
          },
          {
            sequence: 6,
            turn: 1,
            type: "player_eliminated",
            message: "Agent 1 was eliminated and returned 1 coin.",
            actor_id: "player-1",
            target_id: null,
            details: { returned_coins: 1 },
          },
          {
            sequence: 7,
            turn: 1,
            type: "game_finished",
            message: "Agent 2 won the game.",
            actor_id: "player-2",
            target_id: null,
            details: {},
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(finishedMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status", { name: "Action result: Block challenge failed" }))
      .toBeVisible();
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to Seat 01" }))
      .not.toHaveClass("response-thread--concluding");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: Seat 01 revealed Contessa" }))
      .toBeVisible();
    expect(screen.getByRole("img", { name: "Seat 01 reveals Contessa" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "Challenge from Seat 01 to Seat 02" })).toBeNull();
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to Seat 01" }))
      .not.toHaveClass("response-thread--concluding");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: Seat 01 has died" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "Seat 01 reveals Contessa" })).toBeNull();
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to Seat 01" }))
      .toHaveClass("response-thread--concluding");
    expect(screen.getByRole("img", { name: /Assassinate from Seat 01/ }))
      .toHaveClass("action-thread--concluding");
    expect(screen.queryByRole("heading", { name: "Seat 02 wins" })).toBeNull();
    expect(screen.getByLabelText("Agent 2: 2 coins, 2 hidden influence"))
      .not.toHaveClass("player-seat--winner");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.queryByRole("img", { name: "Blocking from Seat 02 to Seat 01" })).toBeNull();
    expect(screen.queryByRole("img", { name: /Assassinate from Seat 01/ })).toBeNull();
    expect(screen.getByRole("status", { name: "Action result: Seat 02 wins" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Seat 02 wins" })).toBeVisible();
    expect(screen.getByLabelText("Agent 2: 2 coins, 2 hidden influence"))
      .toHaveClass("player-seat--winner");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.queryByRole("status", { name: "Action result: Seat 02 wins" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Seat 02 wins" })).toBeVisible();
    expect(screen.getByLabelText("Agent 2: 2 coins, 2 hidden influence"))
      .toHaveClass("player-seat--winner");
  });

  it("labels a blocking route in the middle of its blue line", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const blockingMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        phase: "block_challenge",
        pending_action: {
          actor_id: "player-1",
          action: "steal",
          target_id: "player-2",
          claimed_role: "captain",
        },
        pending_block: { blocker_id: "player-2", claimed_role: "captain" },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(blockingMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to Seat 01" })).toBeVisible();
    expect(screen.getByLabelText("Seat 02 is blocking as Captain"))
      .not.toHaveTextContent("blocking");
    expect(container.querySelector(".response-thread__label--block"))
      .toHaveTextContent("Blocking");
  });

  it("restores a challenged action fully extended instead of replaying it", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const resumedMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 4,
        phase: "block_window",
        pending_action: {
          actor_id: "player-1",
          action: "steal",
          target_id: "player-2",
          claimed_role: "captain",
        },
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Steal as Captain targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal", claimed_role: "captain" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "challenge_declared",
            message: "Agent 2 challenged the claim made by Agent 1.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { claim_kind: "action" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "claim_proven",
            message: "Agent 1 proved the Captain claim.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { role: "captain" },
          },
          {
            sequence: 4,
            turn: 1,
            type: "card_replaced",
            message: "Agent 1 returned the proven card and drew a replacement.",
            actor_id: "player-1",
            target_id: null,
            details: {},
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(resumedMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    const { container } = render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status", { name: "Action result: Action challenge failed" }))
      .toBeVisible();
    expect(screen.getByRole("img", {
      name: "Captain returned from Seat 01 to the Court deck",
    })).toBeVisible();
    expect(screen.getByRole("img", { name: "Steal from Seat 01 to Seat 02" }))
      .toHaveClass("action-thread--resumed", "action-thread--subdued");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole("status", { name: "Action result: Seat 01 drew a replacement" }))
      .toBeVisible();
    expect(screen.getByRole("img", {
      name: "Replacement card drawn from the Court deck to Seat 01",
    })).toBeVisible();
    expect(container.querySelector(".replacement-draw--human")).toBeNull();
    expect(container.querySelector(".replacement-draw__face--front")).toBeNull();
  });

  it("draws and reveals the human player's exact replacement into their hand", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const replacementCard = { id: "replacement-assassin", role: "assassin" as const };
    const replacementMatch: MatchPayload = {
      ...spectatorMatch,
      mode: "human_vs_ai",
      status: "waiting_for_human",
      human_player_id: "player-1",
      view: {
        public: {
          ...publicView,
          players: publicView.players.map((player, index) =>
            index === 0 ? { ...player, name: "You" } : player,
          ),
          history: [
            {
              sequence: 1,
              turn: 1,
              type: "action_declared",
              message: "You declared Tax as Duke.",
              actor_id: "player-1",
              target_id: null,
              details: { action: "tax", claimed_role: "duke" },
            },
            {
              sequence: 2,
              turn: 1,
              type: "challenge_declared",
              message: "Agent 2 challenged the claim made by You.",
              actor_id: "player-2",
              target_id: "player-1",
              details: { claim_kind: "action" },
            },
            {
              sequence: 3,
              turn: 1,
              type: "claim_proven",
              message: "You proved the Duke claim.",
              actor_id: "player-1",
              target_id: "player-2",
              details: { role: "duke" },
            },
            {
              sequence: 4,
              turn: 1,
              type: "card_replaced",
              message: "You returned the proven card and drew a replacement.",
              actor_id: "player-1",
              target_id: null,
              details: {},
            },
          ],
        },
        player_id: "player-1",
        hidden_cards: [replacementCard, { id: "captain-card", role: "captain" }],
        known_setup_discards: [],
        setup_choices: [],
        exchange_cards: [],
        latest_card_replacement: { sequence: 4, card: replacementCard },
        pending_decision: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(replacementMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    const { container } = render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status", { name: "Action result: Action challenge failed" }))
      .toBeVisible();
    expect(screen.getByRole("img", {
      name: "Duke returned from You to the Court deck",
    })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole("status", { name: "Action result: You drew a replacement" }))
      .toBeVisible();
    expect(screen.getByRole("img", {
      name: "Replacement card drawn from the Court deck to You",
    })).toBeVisible();
    expect(container.querySelector(".replacement-draw")).toHaveClass("replacement-draw--human");
    expect(container.querySelector(".replacement-draw__face--front"))
      .toHaveAttribute("src", "/images/cards/assassin.png");
    expect(document.getElementById("hand-card-replacement-assassin")).toBeVisible();
  });

  it("keeps Steal fully extended after the challenge window passes", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const blockWindowMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 2,
        phase: "block_window",
        pending_action: {
          actor_id: "player-1",
          action: "steal",
          target_id: "player-2",
          claimed_role: "captain",
        },
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Steal as Captain targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal", claimed_role: "captain" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "response_passed",
            message: "Agent 2 passed on the action challenge.",
            actor_id: "player-2",
            target_id: null,
            details: { window: "the action challenge" },
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(blockWindowMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status", { name: "Action result: No challenges" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("img", { name: "Steal from Seat 01 to Seat 02" }))
      .toHaveClass("action-thread--resumed");
  });

  it("stamps the acting player's panel when an action is canceled", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const canceledMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 4,
        turn: 2,
        active_player_id: "player-2",
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Steal as Captain targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal", claimed_role: "captain" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "block_declared",
            message: "Agent 2 claimed Captain to block Steal.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { action: "steal", role: "captain" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "response_passed",
            message: "Agent 1 passed on the block challenge.",
            actor_id: "player-1",
            target_id: null,
            details: { window: "the block challenge" },
          },
          {
            sequence: 4,
            turn: 1,
            type: "block_succeeded",
            message: "The Captain block by Agent 2 succeeded.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { action: "steal", role: "captain" },
          },
          {
            sequence: 5,
            turn: 1,
            type: "turn_ended",
            message: "Agent 1's turn ended.",
            actor_id: "player-1",
            target_id: null,
            details: {},
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(canceledMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    const { container } = render(<App />);
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status", { name: "Action result: No challenges" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to Seat 01" }))
      .not.toHaveClass("response-thread--concluding");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole("img", { name: /Steal from Seat 01/ }))
      .toHaveClass("action-thread--subdued", "action-thread--concluding");
    expect(screen.getByRole("img", { name: "Blocking from Seat 02 to Seat 01" }))
      .toHaveClass("response-thread--concluding");
    expect(screen.getByLabelText("Seat 02 is blocking as Captain"))
      .toHaveClass("seat-response-indicator--concluding");
    expect(screen.getByLabelText(/Seat 01 claims Captain for Steal/))
      .toHaveClass("seat-action-claim--subdued", "seat-action-claim--concluding");
    expect(screen.queryByLabelText("Negative action outcome for Seat 01")).toBeNull();
    expect(screen.queryByLabelText("Positive action outcome for Seat 02")).toBeNull();
    expect(container.querySelector(".player-outcome-stamp--negative")).toBeNull();
    expect(container.querySelector(".player-outcome-stamp--positive")).toBeNull();
    expect(screen.getByRole("status", { name: "Action result: Block succeeded" })).toBeVisible();
  });

  it("names an action whose false claim was successfully challenged", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const challengedMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 3,
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Steal as Captain targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal", claimed_role: "captain" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "challenge_declared",
            message: "Agent 2 challenged the claim made by Agent 1.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { claim_kind: "action" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "claim_conceded",
            message: "Agent 1 conceded the Captain claim.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { role: "captain", claim_kind: "action" },
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(challengedMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByRole("status", {
      name: "Action result: Action challenge succeeded",
    })).toBeVisible();
  });

  it("sequences pass-window and action results through the center banner", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const sequencedMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 4,
        turn: 2,
        active_player_id: "player-2",
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Steal as Captain targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal", claimed_role: "captain" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "response_passed",
            message: "Agent 2 passed on the action challenge.",
            actor_id: "player-2",
            target_id: null,
            details: { window: "the action challenge" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "response_passed",
            message: "Agent 2 passed on the block opportunity.",
            actor_id: "player-2",
            target_id: null,
            details: { window: "the block opportunity" },
          },
          {
            sequence: 4,
            turn: 1,
            type: "action_resolved",
            message: "Agent 1 stole 2 coins from Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal" },
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(sequencedMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    const enter = screen.getByRole("button", { name: "Enter the court" });

    await act(async () => {
      fireEvent.click(enter);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status", { name: "Action result: No challenges" })).toBeVisible();
    expect(screen.queryByLabelText("Positive action outcome for Seat 01")).toBeNull();
    expect(screen.queryByLabelText("Negative action outcome for Seat 02")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: No blocks" })).toBeVisible();
    expect(screen.queryByLabelText("Positive action outcome for Seat 01")).toBeNull();
    expect(screen.queryByLabelText("Negative action outcome for Seat 02")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: Steal succeeded" })).toBeVisible();
    expect(screen.getByLabelText("Positive action outcome for Seat 01")).toBeVisible();
    expect(screen.getByLabelText("Negative action outcome for Seat 02")).toBeVisible();
  });

  it("keeps Exchange visible and solid until its completion message", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const exchangeMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 3,
        turn: 2,
        active_player_id: "player-2",
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Exchange as Ambassador.",
            actor_id: "player-1",
            target_id: null,
            details: { action: "exchange", claimed_role: "ambassador" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "response_passed",
            message: "Agent 2 passed on the action challenge.",
            actor_id: "player-2",
            target_id: null,
            details: { window: "the action challenge" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "exchange_completed",
            message: "Agent 1 completed the Exchange.",
            actor_id: "player-1",
            target_id: null,
            details: { action: "exchange" },
          },
          {
            sequence: 4,
            turn: 1,
            type: "turn_ended",
            message: "Agent 1's turn ended.",
            actor_id: "player-1",
            target_id: null,
            details: {},
          },
          {
            sequence: 5,
            turn: 2,
            type: "turn_started",
            message: "Turn 2: Agent 2 acts.",
            actor_id: "player-2",
            target_id: null,
            details: {},
          },
          {
            sequence: 6,
            turn: 2,
            type: "action_declared",
            message: "Agent 2 declared Tax as Duke.",
            actor_id: "player-2",
            target_id: null,
            details: { action: "tax", claimed_role: "duke" },
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(exchangeMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    const { container } = render(<App />);
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status", { name: "Action result: No challenges" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Exchange from Seat 01 to the center of the table" }))
      .not.toHaveClass("action-thread--subdued", "action-thread--concluding");
    expect(screen.getByLabelText(/Seat 01 claims Ambassador for Exchange/))
      .not.toHaveClass("seat-action-claim--subdued", "seat-action-claim--concluding");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: Cannot be blocked" })).toBeVisible();
    expect(container.querySelector(".action-thread"))
      .not.toHaveClass("action-thread--concluding");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: Exchange complete" })).toBeVisible();
    expect(container.querySelector(".action-thread"))
      .toHaveClass("action-thread--concluding");
    expect(screen.getByLabelText(/Seat 01 claims Ambassador for Exchange/))
      .toHaveClass("seat-action-claim--concluding");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.queryByRole("img", { name: "Exchange from Seat 01 to the center of the table" }))
      .toBeNull();
    expect(screen.getByRole("img", { name: "Tax from Seat 02 to the center of the table" }))
      .toBeVisible();
  });

  it("explains that Tax cannot be blocked before resolving it", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const taxMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 3,
        turn: 2,
        active_player_id: "player-2",
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Tax as Duke.",
            actor_id: "player-1",
            target_id: null,
            details: { action: "tax", claimed_role: "duke" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "response_passed",
            message: "Agent 2 passed on the action challenge.",
            actor_id: "player-2",
            target_id: null,
            details: { window: "the action challenge" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "action_resolved",
            message: "Agent 1 took 3 coins as Tax.",
            actor_id: "player-1",
            target_id: null,
            details: { action: "tax" },
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(taxMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    vi.useFakeTimers();
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter the court" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status", { name: "Action result: No challenges" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: Cannot be blocked" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status", { name: "Action result: Tax collected" })).toBeVisible();
  });

  it("announces when the human player has died", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const deathMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 3,
        players: publicView.players.map((player, index) =>
          index === 0 ? { ...player, name: "You", is_alive: false } : player,
        ),
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 2 declared Coup targeting You.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { action: "coup", claimed_role: null },
          },
          {
            sequence: 2,
            turn: 1,
            type: "player_eliminated",
            message: "You were eliminated and returned 2 coins.",
            actor_id: "player-1",
            target_id: null,
            details: { returned_coins: 2 },
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(deathMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByRole("status", { name: "Action result: You have died" })).toBeVisible();
  });

  it("marks the actor positive and target negative after a successful Steal", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const resolvedMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 4,
        turn: 2,
        active_player_id: "player-2",
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Steal as Captain targeting Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal", claimed_role: "captain" },
          },
          {
            sequence: 2,
            turn: 1,
            type: "action_resolved",
            message: "Agent 1 stole 2 coins from Agent 2.",
            actor_id: "player-1",
            target_id: "player-2",
            details: { action: "steal" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "turn_ended",
            message: "Agent 1's turn ended.",
            actor_id: "player-1",
            target_id: null,
            details: {},
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(resolvedMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByRole("img", { name: /Steal from Seat 01/ }))
      .toHaveClass("action-thread--concluding");
    expect(screen.getByLabelText(/Seat 01 claims Captain/))
      .toHaveClass("seat-action-claim--concluding");
    expect(screen.getByLabelText("Positive action outcome for Seat 01")).toBeVisible();
    expect(screen.getByLabelText("Negative action outcome for Seat 02")).toBeVisible();
    expect(screen.getByRole("status", { name: "Action result: Steal succeeded" })).toBeVisible();
    expect(container.querySelector(".player-outcome-stamp--positive")).not.toBeNull();
    expect(container.querySelector(".player-outcome-stamp--negative")).not.toBeNull();
    const chronicleMessages = Array.from(
      container.querySelectorAll(".history-list__event p"),
      (element) => element.textContent ?? "",
    );
    expect(chronicleMessages[0]).toContain("turn ended");
    expect(chronicleMessages.at(-1)).toContain("declared Steal");
  });

  it("animates resolved Income before showing its positive outcome", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const resolvedMatch: MatchPayload = {
      ...spectatorMatch,
      view: {
        ...publicView,
        version: 3,
        turn: 2,
        active_player_id: "player-2",
        history: [
          {
            sequence: 1,
            turn: 1,
            type: "action_declared",
            message: "Agent 1 declared Income.",
            actor_id: "player-1",
            target_id: null,
            details: { action: "income", claimed_role: null },
          },
          {
            sequence: 2,
            turn: 1,
            type: "action_resolved",
            message: "Agent 1 took 1 coin as Income.",
            actor_id: "player-1",
            target_id: null,
            details: { action: "income" },
          },
          {
            sequence: 3,
            turn: 1,
            type: "turn_ended",
            message: "Agent 1's turn ended.",
            actor_id: "player-1",
            target_id: null,
            details: {},
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(resolvedMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByRole("img", {
      name: "Income from Seat 01 to the center of the table, succeeded",
    })).toBeVisible();
    expect(screen.queryByLabelText(/Seat 01 claims Income/)).toBeNull();
    expect(screen.getByLabelText("Positive action outcome for Seat 01"))
      .toHaveClass("player-outcome-stamp--delayed");
    expect(screen.getByRole("status", { name: "Action result: Income collected" }))
      .toHaveClass("court-result--delayed");
    expect(screen.getByRole("article", { name: /Agent 1: 2 coins/ }))
      .toHaveClass("player-seat--active");
    expect(screen.getByRole("article", { name: /Agent 2: 2 coins/ }))
      .not.toHaveClass("player-seat--active");
    expect(container.querySelector(".action-thread__label")).toHaveTextContent("Income");
    expect(container.querySelector(".player-outcome-stamp--negative")).toBeNull();
  });

  it("animates a resolved Coup to its target with a labeled line", async () => {
    const publicView = spectatorMatch.view as PublicGameView;
    const coupMatch: MatchPayload = {
      ...spectatorMatch,
      status: "waiting_for_human",
      human_player_id: "player-2",
      pending_human_decision: {
        id: "reveal-after-coup",
        state_version: 2,
        player_id: "player-2",
        kind: "lose_influence",
        prompt: "You were targeted by a Coup",
        options: [{ id: "reveal:one", label: "Reveal a card", data: { card_id: "one" } }],
      },
      view: {
        public: {
          ...publicView,
          version: 2,
          phase: "influence_loss",
          history: [
            {
              sequence: 1,
              turn: 1,
              type: "action_declared",
              message: "Agent 1 declared Coup targeting You.",
              actor_id: "player-1",
              target_id: "player-2",
              details: { action: "coup", claimed_role: null },
            },
            {
              sequence: 2,
              turn: 1,
              type: "action_resolved",
              message: "The Coup by Agent 1 against You succeeded.",
              actor_id: "player-1",
              target_id: "player-2",
              details: { action: "coup" },
            },
          ],
        },
        player_id: "player-2",
        hidden_cards: [{ id: "one", role: "duke" }],
        known_setup_discards: [],
        setup_choices: [],
        exchange_cards: [],
        pending_decision: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(coupMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.getByRole("img", {
      name: "Coup from Seat 01 to Seat 02, succeeded",
    })).toBeVisible();
    expect(container.querySelector(".action-thread__label")).toHaveTextContent("Coup");
    expect(screen.getByLabelText("Positive action outcome for Seat 01"))
      .toHaveClass("player-outcome-stamp--delayed");
    expect(screen.getByLabelText("Negative action outcome for Seat 02"))
      .toHaveClass("player-outcome-stamp--delayed");
  });

  it("explains a claimed character during a challenge decision", async () => {
    const challengeMatch: MatchPayload = {
      ...spectatorMatch,
      mode: "human_vs_ai",
      status: "waiting_for_human",
      human_player_id: "player-2",
      pending_human_decision: {
        id: "challenge-duke",
        state_version: 1,
        player_id: "player-2",
        kind: "action_challenge",
        prompt: "Challenge the Duke claim made by Agent 1?",
        options: [
          { id: "pass", label: "Pass", data: {} },
          { id: "challenge", label: "Challenge Agent 1", data: {} },
        ],
      },
      view: {
        ...spectatorMatch.view,
        phase: "action_challenge",
        pending_action: {
          actor_id: "player-1",
          action: "tax",
          target_id: null,
          claimed_role: "duke",
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/health") return Promise.resolve(jsonResponse(health));
        if (path === "/api/games" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(challengeMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    const reminder = await screen.findByRole("complementary", { name: "Duke powers" });
    expect(screen.getByRole("heading", { name: "Challenge the Duke claim made by Seat 01?" })).toBeVisible();
    const challenge = screen.getByRole("button", { name: /Challenge Seat 01/ });
    await user.hover(challenge);
    expect(challenge).toHaveTextContent("A false claimant loses influence");
    expect(challenge).toHaveTextContent("if the claim is proven, you lose influence instead");
    expect(reminder).toHaveTextContent("Tax: take 3 coins");
    expect(reminder).toHaveTextContent("block another player's Foreign Aid");
  });
});
