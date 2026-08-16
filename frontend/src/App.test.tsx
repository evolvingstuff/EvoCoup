import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Observe Watch agents scheme" }));
    await user.click(screen.getByRole("button", { name: "2 players" }));
    await user.click(screen.getByRole("button", { name: "Enter the court" }));

    expect(await screen.findByText("The court is paused")).toBeVisible();
    expect(screen.getByRole("button", { name: "› Step" })).toBeEnabled();
    const createCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/games");
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      player_count: 2,
      mode: "ai_only",
    });
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
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));

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
    await user.click(await screen.findByRole("button", { name: "› Step" }));

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
              type: "challenge_declared",
              message: "You challenged the block made by Agent 2.",
              actor_id: "player-1",
              target_id: "player-2",
              details: { claim_kind: "block" },
            },
            {
              sequence: 2,
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
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    const warning = screen.getByText("You lost a challenge against Seat 02.");
    const instruction = screen.getByRole("heading", { name: "Choose an influence to reveal." });
    expect(warning).toHaveClass("decision-consequence");
    expect(warning.compareDocumentPosition(instruction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Negative action outcome for You")).toBeVisible();
    expect(screen.queryByLabelText("Positive action outcome for Seat 02")).toBeNull();
    expect(screen.queryByLabelText("You are challenging")).toBeNull();
    expect(screen.queryByRole("img", { name: "Challenge from You to Seat 02" })).toBeNull();
  });

  it("shows only the newest response path when blocks and challenges overlap", async () => {
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
    expect(screen.getByLabelText("Seat 01 is challenging")).toBeVisible();
    expect(screen.queryByRole("img", { name: "Block from Seat 02 to Seat 01" })).toBeNull();
    expect(screen.getByRole("img", { name: "Challenge from Seat 01 to Seat 02" })).toBeVisible();
    expect(container.querySelectorAll(".action-thread, .response-thread")).toHaveLength(1);
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
            type: "block_succeeded",
            message: "The Captain block by Agent 2 succeeded.",
            actor_id: "player-2",
            target_id: "player-1",
            details: { action: "steal", role: "captain" },
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
          return Promise.resolve(jsonResponse(canceledMatch));
        }
        return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enter the court" }));
    expect(screen.queryByRole("img", { name: /Steal from Seat 01/ })).toBeNull();
    expect(screen.queryByLabelText("Negative action outcome for Seat 01")).toBeNull();
    expect(screen.queryByLabelText("Positive action outcome for Seat 02")).toBeNull();
    expect(container.querySelector(".player-outcome-stamp--negative")).toBeNull();
    expect(container.querySelector(".player-outcome-stamp--positive")).toBeNull();
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
    expect(screen.queryByRole("img", { name: /Steal from Seat 01/ })).toBeNull();
    expect(screen.queryByLabelText(/Seat 01 claims Captain/)).toBeNull();
    expect(screen.getByLabelText("Positive action outcome for Seat 01")).toBeVisible();
    expect(screen.getByLabelText("Negative action outcome for Seat 02")).toBeVisible();
    expect(container.querySelector(".player-outcome-stamp--positive")).not.toBeNull();
    expect(container.querySelector(".player-outcome-stamp--negative")).not.toBeNull();
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
