# EvoCoup redevelopment plan

## 1. Purpose

Rebuild EvoCoup as a faithful, local-only implementation of the base game of Coup with a fully tested Python rules engine and a game-oriented web interface. A single human can play against one to five OpenAI-controlled opponents, or watch a two-to-six-player game consisting entirely of OpenAI-controlled players.

The project is a personal experiment. It does not need accounts, deployment, saved games, mobile support, dialogue, bespoke artwork, or evolutionary learning in v1.

The old implementation is useful as historical context and as evidence that randomized games are valuable stress tests. It is not the foundation of the new engine. Move `coup.py` to `legacy/coup.py` when implementation begins, then build the new system independently.

## 2. Product decisions

These decisions are settled for v1:

- Faithfully implement the published base Coup rules, including the published two-player variant.
- Support two through six total players.
- Support exactly zero or one human player. All remaining seats are LLM-controlled.
- Run entirely on the user's laptop.
- Use Python for the rules engine, orchestration, OpenAI integration, and HTTP/WebSocket API.
- Use FastAPI for the backend and React with TypeScript for the frontend.
- Use normal DOM elements for cards and controls, with CSS/React animation. Use canvas only later if a specific visual effect benefits from it.
- Use the OpenAI Responses API. Start with `gpt-5.6-terra` at low reasoning effort, but make the model and reasoning effort configurable.
- Give all AI seats the same strategy prompt in v1.
- Make every AI decision a real model call. Never substitute a random or heuristic decision after an API failure.
- Stop the match at the current decision when an API call fails. Show the error and allow a manual retry of that same decision.
- Prompt the human every time a human decision is required. There are no timers or default responses.
- Include a developer panel, hidden by default, with model inputs, legal choices, selected choices, stated rationales, token usage, latency, raw responses, and errors.
- Do not persist games, transcripts, debug records, or event logs. All match state and transient history disappear when the server is stopped or a new game replaces the current game.
- Use a clean animated placeholder visual treatment in v1. Renaissance woodcut-style original artwork is a later milestone; the existing generated images will not guide the new art direction.
- Do not add sound or music in v1.
- Do not implement dialogue, negotiation, persistent agents, multiple model providers, automated LLM tournaments, or evolution in v1.

## 3. Definition of v1

V1 is complete when a user can start the application locally, choose a human-versus-AI or AI-only match with two through six seats, play or watch a complete rules-correct game, inspect optional agent diagnostics, retry a failed agent decision, and start another game without restarting the application.

The following flows must all work:

1. Normal setup for three through six players.
2. Published setup variant for two players.
3. Human action, target, challenge, block, proof/concession, influence-loss, and exchange decisions.
4. The same decisions made by an OpenAI model using strict structured output.
5. Human-vs-AI play with every human response explicitly prompted.
6. AI-only play with pause, one-decision step, 1x, 2x, and instant pacing controls.
7. Game completion and winner display.
8. Hard-stop API error handling with a manual retry and no automatic fallback move.
9. An optional developer panel that explains what each model saw and returned.

## 4. Canonical rules scope

The engine should treat the published base rules as authoritative. The initial reference is the rules page already linked by the repository: <https://www.ultraboardgames.com/coup/game-rules.php>. The publisher's game page confirms the base game's two-to-six-player scope: <https://indieboardsandcards.com/our-games/coup/>.

Do not include Reformation, the Inquisitor, promotional roles, or house rules.

### 4.1 Components and conservation

- The deck contains exactly 15 uniquely identified cards: three each of Duke, Assassin, Captain, Ambassador, and Contessa.
- The treasury and all player holdings contain exactly 50 coins in total.
- Revealed influence remains face-up with its player and never returns to the Court deck.
- When a player is eliminated, all of that player's coins return to the treasury.
- The engine tracks cards by unique ID as well as role. This makes conservation assertions possible even though roles have duplicate copies.

### 4.2 Normal setup for three through six players

- Shuffle all 15 cards using an injected random-number source.
- Deal two face-down influences to every player.
- Give every player two coins.
- Put all remaining cards in the Court deck and all remaining coins in the treasury.
- Select a starting player randomly because v1 does not retain the winner of a previous game.
- Play proceeds clockwise, skipping eliminated players.

### 4.3 Published two-player variant

- Divide the cards into three five-card sets, each containing one of every role.
- Give one set to each player. Each player privately chooses one card and the other four cards from that set are placed in a tracked, seat-associated out-of-play zone.
- Shuffle the third set, deal one additional card to each player, and use the remaining three cards as the Court deck.
- The starting player begins with one coin; the other player begins with two.
- Randomly select the starting player before the private card-selection decisions.
- The out-of-play zone participates in card-conservation checks. Each player remembers the four cards discarded from their own set but cannot inspect the other player's four discarded cards. A seat view must preserve this asymmetric knowledge.

### 4.4 Turn and action rules

A living player must take exactly one action and may not pass.

General actions:

| Action | Cost/effect | Challenge | Block |
| --- | --- | --- | --- |
| Income | Gain 1 coin | No | No |
| Foreign Aid | Gain 2 coins | No | Any opponent may claim Duke |
| Coup | Pay 7 coins; target loses one influence | No | No |

Character actions:

| Claim | Action | Cost/effect | Block |
| --- | --- | --- | --- |
| Duke | Tax | Gain 3 coins | No |
| Assassin | Assassinate | Pay 3 coins; target loses one influence | Target may claim Contessa |
| Captain | Steal | Transfer up to 2 coins from target | Target may claim Captain or Ambassador |
| Ambassador | Exchange | Draw 2 from Court, then keep only the number of face-down influences held before drawing | No |

Additional constraints:

- A player may claim any character action whether or not that character is in their hand.
- A player beginning a turn with ten or more coins must Coup.
- Coup and Assassinate costs are paid when the action is declared.
- If the acting player's character claim is successfully challenged, the action fails and its paid cost is refunded.
- If an action is successfully blocked, its paid cost remains spent.
- Steal may target any living opponent and transfers `min(2, target.coins)`.
- The target of Coup, Assassinate, or Steal must be another living player.
- The affected player chooses which influence to reveal whenever influence is lost.

### 4.5 Challenges

- Tax, Assassinate, Steal, and Exchange claims may be challenged by any other living player.
- A block is also a character claim and may be challenged by any other living player except the blocker.
- Income, Foreign Aid, and Coup cannot be challenged.
- Challenge opportunities are offered clockwise from the claimant. The first player to challenge ends that response window; a player who passes cannot retroactively challenge.
- If nobody challenges, the claim stands without revealing a card.
- When challenged, a claimant holding the claimed role may prove the claim or deliberately concede. A claimant not holding the role can only concede.
- On proof, the challenger chooses and reveals one influence. The claimant returns one matching hidden card to the Court deck, the Court deck is shuffled, and the claimant draws one random replacement. The original action or block then continues.
- On concession, the claimant chooses and reveals one influence. An action claim fails and refunds its declared cost. A block claim fails and the original action continues.
- If an influence-loss decision eliminates a player, elimination and victory checks happen immediately before continuing the pending action.

### 4.6 Blocks

- Resolve the action challenge window before offering any block.
- For Foreign Aid, offer the block opportunity to opponents clockwise from the actor. The first declared Duke block becomes the only block claim.
- For Assassinate, only the target may claim Contessa.
- For Steal, only the target may claim Captain or Ambassador.
- After a block claim, offer its challenge window clockwise from the blocker.
- An unchallenged block succeeds and cancels the action.
- A proven block succeeds after the challenger loses influence.
- A conceded or disproven block fails after the blocker loses influence; the original action continues.
- Coins already paid for an action remain spent when its block succeeds.

### 4.7 Assassination edge cases

The engine must explicitly cover the published double-loss cases:

- If an assassination target challenges a truthful Assassin and loses, the target loses an influence for the challenge and then another influence when the assassination resolves, if the target still has one.
- If a target falsely claims Contessa, is challenged, and concedes or cannot prove it, the target loses an influence for the failed block and then another when the assassination resolves, if one remains.
- If either loss eliminates the target, do not request an impossible second influence choice.
- If challenge resolution leaves only one living player, end the game immediately instead of continuing obsolete pending effects.

### 4.8 Negotiation

Published Coup permits nonbinding negotiation, but v1 has no table dialogue. This does not affect the rules engine. Dialogue can later be added as public, nonbinding events that never mutate rules state directly.

## 5. Rules-engine architecture

The rules engine must be a standalone Python package with no FastAPI, React, OpenAI, network, or storage dependencies. It owns truth, legal moves, hidden information, randomness, and state transitions. The model and UI are untrusted decision providers.

### 5.1 Design principles

- Deterministic given an initial seed and the same sequence of decisions.
- Mutation only through validated commands.
- Exactly one pending external decision at a time.
- Illegal or stale decisions fail without partially mutating state.
- Rules logic never calls a human, model, API, clock, filesystem, or UI.
- Private state is never serialized through a public view accidentally.
- Randomness is injected and can be seeded or replaced in tests.
- Transitions emit typed transient events for animation, public history, and debugging.
- All invariants are checked in tests and optionally after every transition in development mode.

### 5.2 Core types

Use typed enums and frozen dataclasses for domain values where practical. Pydantic models belong at API and OpenAI boundaries rather than inside the core engine.

Suggested domain types:

- `Role`: Duke, Assassin, Captain, Ambassador, Contessa.
- `ActionType`: Income, Foreign Aid, Coup, Tax, Assassinate, Exchange, Steal.
- `BlockClaim`: Duke, Contessa, Captain, Ambassador.
- `Card`: unique card ID and role.
- `Influence`: card and hidden/revealed status.
- `PlayerState`: stable player ID, seat index, name, coins, influences, and elimination status. Human/AI controller assignment belongs to the application layer, not the rules state.
- `PendingAction`: actor, action type, optional target, claimed role, paid cost, and resolution status.
- `PendingBlock`: blocker, claimed role, and blocked action.
- `GamePhase`: setup choice, action choice, action challenge, claim proof, influence loss, block choice, block challenge, exchange choice, or finished.
- `GameState`: players in seat order, Court deck, out-of-play cards, treasury, active seat, turn number, phase, pending action/block, response queue, transient public history, winner, and optimistic version number.
- `DecisionRequest`: decision ID, state version, acting player, decision kind, and typed legal options.
- `Decision`: decision ID, expected version, and one selected legal option.
- `GameEvent`: typed state-transition result with explicit public and private projections.

### 5.3 Decision kinds

The engine should expose a uniform `pending_decision()` interface covering:

- Two-player initial private card selection.
- Turn action plus target selection.
- Pass or challenge an action claim.
- Pass or make an eligible block claim.
- Pass or challenge a block claim.
- Prove a claim or concede it.
- Choose an influence to reveal.
- Choose cards to keep after Exchange.

The legal option IDs should be opaque, stable for the life of the decision, and sufficient for both UI buttons and structured model output. The engine—not the model or frontend—enumerates all legal options.

### 5.4 State-machine outline

```text
SETUP
  -> optional two-player private choices
  -> AWAIT_ACTION
  -> declare action and pay cost
     -> unchallengeable action
        -> optional block window or resolve
     -> character action challenge window
        -> claim conceded: lose influence, refund cost, end turn
        -> claim proven: challenger loses influence, continue action
        -> nobody challenges: continue action
     -> optional block window
        -> nobody blocks: resolve action
        -> block declared: block challenge window
           -> block unchallenged/proven: cancel action, end turn
           -> block conceded: blocker loses influence, resolve action
     -> resolve action and any required influence/exchange choice
  -> eliminate players and check victory after every influence loss
  -> advance clockwise to next living player
  -> AWAIT_ACTION or FINISHED
```

Immediate engine transitions should run until another external decision is required or the game ends. This keeps orchestration simple and makes each human/model interaction exactly one typed decision.

### 5.5 Views and secrecy

Create explicit projections instead of serializing `GameState` directly:

- `PublicGameView`: public coins, seat order, revealed cards, active player, pending public claim/action, public history, and winner.
- `SeatGameView`: public view plus that seat's hidden cards, private exchange/setup choices, and—during the two-player variant—the four cards that seat knowingly discarded during setup.
- `DeveloperGameView`: full state and per-call debug records for the local developer panel.

Never include the Court deck order, the other player's two-player set-aside cards, or another player's hidden influence in a seat view. Tests must recursively inspect all agent payloads and ordinary API/WebSocket payloads for forbidden card IDs and roles.

The developer panel is allowed to reveal all information because it is an explicit local debugging surface. Opening it during a human game should show a clear warning that it can spoil hidden information.

### 5.6 Transient history

The game needs an in-memory public history so agents understand prior claims and the UI can render the current match. This is not persistence:

- Keep only the current match in memory.
- Do not write history or debug records to disk.
- Do not provide export/import in v1.
- Starting a new match discards the previous match.
- Restarting the backend loses the match.

## 6. Decision-provider architecture

Define a small asynchronous boundary shared by human and AI control:

```python
class DecisionProvider(Protocol):
    async def decide(self, request: AgentDecisionRequest) -> AgentDecision: ...
```

The game runner asks the engine for the next pending decision, routes it to the correct controller, validates the response through the engine, emits resulting events, and repeats until the next human decision, a pacing boundary, match completion, or an error.

The random policy from the old prototype may be reimplemented only under test/support code for headless stress testing. It is never a production fallback.

## 7. OpenAI integration

### 7.1 API choice and configuration

- Use the official Python SDK and the Responses API.
- Use strict structured output backed by a Pydantic response model.
- Default model: `gpt-5.6-terra`.
- Default reasoning effort: `low`.
- Read `OPENAI_API_KEY` only on the backend.
- Read model, reasoning effort, and request timeout from environment-backed settings.
- Suggested defaults: `EVOCOUP_OPENAI_MODEL=gpt-5.6-terra`, `EVOCOUP_REASONING_EFFORT=low`, and `EVOCOUP_OPENAI_TIMEOUT_SECONDS=90`.
- Keep `.env` ignored. Provide `.env.example` without credentials.
- Do not expose the API key, authorization headers, or SDK client configuration to the browser or debug panel.

### 7.2 Prompt contract

Use one versioned system prompt for every AI seat in v1. The prompt should:

- Explain that the model is playing a faithful game of Coup to win.
- Explain bluffing and hidden information without prescribing a fixed personality.
- State that only the supplied seat view is known and other hidden cards must not be assumed.
- Describe the current decision kind.
- Require selection of exactly one supplied legal option ID.
- Require a concise, user-displayable rationale rather than private chain-of-thought.
- Forbid invented actions, targets, rules, side effects, or conversational output outside the schema.

Each call receives:

- The AI's seat identity and its private `SeatGameView`.
- The complete public action/challenge history for the current match.
- The current decision request.
- An enumerated list of legal option IDs with human-readable meanings.

Each call returns only:

```json
{
  "choice_id": "opaque legal option ID",
  "rationale": "One concise, displayable reason for the choice."
}
```

The application should make stateless calls and own the history itself. Do not rely on provider-side conversation state in v1. This makes seat privacy, retry behavior, tests, and later provider adapters easier to reason about.

### 7.3 Validation and failure behavior

- Parse the response against the strict schema.
- Confirm that `choice_id` belongs to the still-current pending decision.
- Apply no engine mutation until parsing and validation succeed.
- Treat timeout, authentication failure, rate limit, network failure, refusal, malformed output, or illegal choice as a stopped-match error.
- Do not automatically retry.
- Do not choose a fallback action.
- Retain the unchanged pending decision, board state, model input, error details, usage if present, and latency.
- A manual Retry button repeats that same pending decision. The state version and decision ID must still match, making retry idempotent with respect to game state.

### 7.4 Diagnostics

For every model decision, retain in memory:

- Match, turn, seat, and decision IDs.
- Sanitized request payload and seat view.
- Legal options.
- Model name and reasoning effort.
- Start time, elapsed latency, and token usage.
- Parsed choice and stated rationale.
- Raw response metadata/body where available.
- Sanitized error information on failure.

Never retain or display the API key or authorization headers. The developer panel should be collapsed by default and offer filters by seat, turn, and decision type.

## 8. Backend application and API

### 8.1 Responsibilities

The FastAPI application should:

- Own one in-memory current match.
- Track application-level match status separately from `GameState`: running, spectator-paused, agent-error-paused, or finished.
- Create and replace matches.
- Project human-safe game state.
- Accept human decisions with decision IDs and expected state versions.
- Drive AI decisions asynchronously.
- Implement spectator pacing controls at decision boundaries.
- Broadcast typed events and state changes over WebSocket.
- Expose sanitized developer diagnostics.
- Pause on model errors and resume only on manual retry.

It must not duplicate or independently infer rules that belong in the engine.

### 8.2 Proposed endpoints

Exact route names can change during implementation, but the boundary should cover:

- `GET /api/health` — backend status and whether an API key is configured, never the key itself.
- `GET /api/config` — safe runtime configuration such as model name and supported player counts.
- `POST /api/games` — replace the current match using mode and total player count.
- `GET /api/games/current` — current human-safe state and pending human decision, if any.
- `POST /api/games/current/decisions` — submit one human decision with decision ID and expected version.
- `POST /api/games/current/retry` — retry the failed AI decision.
- `POST /api/games/current/control` — play, pause, step one external decision, or change spectator speed.
- `GET /api/games/current/debug` — full local diagnostics for the optional developer panel.
- `WS /api/games/current/events` — public events, state-version notifications, pending human decisions, pacing state, completion, and errors.

Use discriminated Pydantic unions for request, response, and event payloads. Reject stale commands with an explicit conflict response. Generate an OpenAPI schema and derive or validate corresponding TypeScript types rather than maintaining two unrelated representations by hand.

### 8.3 Runner and pacing

- In human mode, advance automatically through immediate transitions and AI decisions until the engine needs a human decision, an error occurs, or the game ends.
- In AI-only mode, pause at decision boundaries when requested.
- `Step` executes exactly one external AI decision plus all consequent immediate rules transitions, then pauses at the next external decision.
- 1x and 2x control deliberate inter-decision/animation pacing; instant removes artificial delay but cannot remove model latency.
- The backend is authoritative. The frontend may queue animations but must reconcile to the newest state version after each sequence.
- Cancel or ignore obsolete background work when a new game replaces the current game.

## 9. Frontend experience

### 9.1 Setup screen

Allow the user to choose:

- Human vs AI or AI-only.
- Total players from two through six.
- Start game.

The configured model can be displayed read-only in v1. Per-seat models and strategies are future work.

### 9.2 Game table

Create a laptop-first responsive table supporting two through six seats:

- Opponents arranged around a central Court deck and treasury.
- Visible coin counts and revealed influence for every player.
- Face-down card count for opponents.
- Human cards face-up only to the human viewer.
- Clear active-player and current-claim treatment.
- A concise public activity feed.
- Legal action buttons only when it is the human's decision.
- Target selection integrated into action choices.
- Dedicated modal or tray for challenge, block, proof/concession, influence-loss, two-player setup, and Exchange decisions.
- Explicit confirmation for irreversible influence and Exchange choices when useful, without adding confirmation to every trivial action.
- Winner and new-game screen.

Use semantic buttons and readable HTML for core interactions. Add animation with CSS and a React animation library for dealing, coin transfers, card reveals, card exchange, elimination, and turn focus. Respect reduced-motion preferences.

### 9.3 Human prompts

- Never auto-pass for the human.
- Do not use a countdown timer.
- Explain why the prompt is being shown and identify the claim, claimant, action, and target.
- Display every legal response and no illegal responses.
- Disable duplicate submission while a decision is in flight.
- Reconcile cleanly if the server rejects a stale decision.

### 9.4 AI-only controls

- Play/pause.
- Step one model decision.
- 1x, 2x, and instant modes.
- Current AI-thinking indicator including seat name.
- Ability to open the developer panel while paused or running.

### 9.5 Developer panel

The panel is hidden by default and should include:

- A warning that it may reveal hidden information and spoil a human match.
- Per-decision request, legal options, choice, and concise rationale.
- Model configuration, latency, and token usage.
- Sanitized raw response and error details.
- Filters by player, turn, and decision type.
- A full-state view useful for debugging card and coin conservation.

No download, export, or persistence is required.

### 9.6 Placeholder visual direction

V1 should look intentional without waiting for final artwork:

- Warm parchment, ink, dark wood, muted burgundy, and restrained gold accents.
- Typographic or emblem-based placeholder role cards.
- Subtle paper/ink texture made with CSS or properly licensed local assets.
- Clear animation and information hierarchy before decorative detail.
- Do not reuse the four existing images in the product UI.

Future art should explore original Renaissance woodcut-style portraits and UI ornamentation while retaining excellent card readability.

## 10. Proposed repository structure

```text
EvoCoup/
  PLAN.md
  README.md
  .env.example
  .gitignore
  pyproject.toml
  legacy/
    coup.py
  src/
    evocoup/
      domain/
        enums.py
        models.py
        decisions.py
        events.py
        engine.py
        views.py
        invariants.py
      application/
        match.py
        runner.py
        pacing.py
      agents/
        base.py
        openai_agent.py
        prompts.py
        schemas.py
      api/
        app.py
        routes.py
        websocket.py
        schemas.py
        settings.py
  tests/
    domain/
    application/
    agents/
    api/
    stress/
  web/
    package.json
    vite.config.ts
    src/
      api/
      components/
      game/
      screens/
      state/
      styles/
      types/
    tests/
    e2e/
  images/
    ...legacy concept images...
```

Keep engine tests alongside the Python project at the repository root. The frontend remains a conventional Vite application under `web/`.

## 11. Tooling and local development

### Python

- Python 3.12 or newer.
- `uv` for environments, locking, and commands.
- FastAPI and Uvicorn for the local server.
- Official `openai` Python SDK.
- Pydantic settings for environment configuration and boundary schemas.
- `pytest`, `pytest-asyncio`, and Hypothesis for tests.
- Ruff for formatting and linting.
- Mypy or Pyright in strict-enough mode for application code.

### Frontend

- React and TypeScript using Vite.
- Standard npm package management.
- A lightweight React animation library plus CSS transitions.
- Vitest and React Testing Library for component tests.
- Playwright for browser-level flows.
- ESLint and Prettier.

### Developer commands

Provide documented commands for:

- Installing Python and frontend dependencies.
- Running backend and frontend development servers together.
- Running fast tests.
- Running full tests, including browser tests.
- Running the long headless stress suite.
- Formatting, linting, and type checking.

The final implementation should offer one obvious local startup command or small script after initial dependency installation.

## 12. Testing strategy

Testing is a primary deliverable, not cleanup after the UI.

### 12.1 Domain unit tests

Test every action and transition, including:

- Setup and deck composition for every supported player count.
- Published two-player selection setup and one-coin starting player.
- Legal action enumeration at different coin totals.
- Forced Coup at ten or more coins.
- Coup payment and influence choice.
- Assassin payment, action-challenge refund, and successful-block non-refund.
- Tax, Income, and Foreign Aid treasury changes.
- Steal with zero, one, and at least two target coins.
- Exchange with one and two remaining influences.
- Truthful and false action claims.
- Intentional concession while holding the claimed role.
- Truthful, false, challenged, and unchallenged blocks.
- Correct eligibility for each block.
- Clockwise challenge/block response ordering and pass finality.
- Both assassination double-loss paths.
- Eliminations during every challenge stage.
- Coin return on elimination.
- Immediate victory detection.
- Stale, duplicate, illegal, and wrong-player decisions.

### 12.2 Property and invariant tests

Use Hypothesis to generate valid states or command sequences and continuously assert:

- Exactly 15 unique card IDs exist across player influence, Court deck, and two-player out-of-play cards.
- Each role appears exactly three times.
- Exactly 50 coins exist across players and treasury.
- No coin count is negative.
- A living player has one or two hidden influences.
- An eliminated player has no hidden influence.
- Revealed cards never re-enter the Court deck.
- Only a proven claim card is returned and replaced.
- At most one decision is pending.
- The pending decision belongs to a living eligible player.
- State versions increase only after accepted transitions.
- Finished games have exactly one living winner and no pending decision.
- Seat/public views never leak forbidden hidden cards.

### 12.3 Headless stress tests

Implement simple deterministic and seeded-random legal decision providers under test code. They exist to exercise the engine, not to play well.

- Run hundreds of complete games in the ordinary test suite across all player counts.
- Provide a marked long test capable of running at least 10,000 games locally.
- Assert termination within a generous turn ceiling and treat exceeding it as a diagnostic failure, not an in-game rule.
- Record only failure seeds and minimal reproduction information in test output.
- Never call OpenAI from these tests.

### 12.4 Application and API tests

- Runner stops correctly at human decisions.
- AI-only pause and step operate at decision boundaries.
- New-game replacement invalidates obsolete work.
- WebSocket events preserve order and state versions.
- Stale HTTP decisions return conflicts without mutation.
- Public endpoints omit private state.
- Debug endpoints sanitize secrets.
- An API-error pause retains the exact pending decision.
- Manual retry applies at most one decision.

### 12.5 OpenAI adapter tests

Use mocked SDK responses for the normal suite:

- Correct seat-specific request construction.
- Strict schema parsing.
- Legal option validation.
- Prompt/version inclusion.
- Timeout, rate limit, auth failure, refusal, malformed response, and illegal-choice handling.
- No hidden information from other players.
- Token, latency, response, and error diagnostics.
- No state mutation and no automatic retry on failure.

Provide one opt-in live API smoke test that is skipped unless an explicit environment flag is set. It must never be required for normal tests.

### 12.6 Frontend and end-to-end tests

- Setup validation for each mode and player count.
- Action/target selection.
- Every human prompt type.
- No human timeout or automatic pass.
- Animation-independent state correctness.
- Developer panel hidden state, warning, filters, and diagnostics.
- API failure display and manual retry.
- Spectator play, pause, step, speed, and instant modes.
- Complete scripted human-vs-AI and AI-only games using a fake backend/model adapter.
- Basic keyboard use and reduced-motion behavior.

## 13. Implementation phases

Each phase should leave the repository runnable or testable and should meet its exit criteria before the next phase starts.

### Phase 0: repository foundation

- Move the old script to `legacy/coup.py` without modifying its behavior.
- Add Python and frontend project scaffolding, dependency locks, formatting, linting, typing, test configuration, `.env.example`, and updated ignore rules.
- Update the README with the new purpose and local developer workflow.

Exit criteria: clean installs succeed; empty test/lint/typecheck commands run; the legacy script remains available.

### Phase 1: rules model and setup

- Implement card, player, game, decision, event, and view types.
- Implement seeded randomness, normal setup, published two-player setup, turn order, legal action enumeration, and invariants.
- Implement explicit public, seat-private, and developer views.

Exit criteria: setup and secrecy tests pass for every player count; card and coin conservation are proven by tests.

### Phase 2: complete state machine

- Implement costs, all actions, target selection, action challenges, proof/concession, influence selection, blocks, block challenges, Exchange, elimination, victory, and every assassination edge case.
- Emit typed events and retain transient public history.

Exit criteria: the full rule matrix, regression cases from the old implementation, and all domain unit/property tests pass.

### Phase 3: headless verification

- Add deterministic scripted providers and a seeded-random legal provider under test support.
- Run games across every player count and decision branch.
- Add the long 10,000-game stress target.

Exit criteria: ordinary stress tests and the long local suite complete without invariant violations, illegal states, or nontermination.

### Phase 4: application runner and FastAPI

- Implement the in-memory match owner, controller routing, immediate transition loop, spectator pacing, endpoint schemas, WebSocket events, stale-decision protection, and error-pause state.
- Use a fake AI provider until the application behavior is fully tested.

Exit criteria: API tests can create and finish scripted human and spectator matches without OpenAI or a browser.

### Phase 5: OpenAI decision provider

- Add environment configuration, the versioned common prompt, seat-safe request builder, strict response schema, manual retry behavior, and diagnostics.
- Add mocked adapter tests and an opt-in live smoke test.

Exit criteria: every AI decision type works through mocked Responses API calls; failures stop without fallback or state mutation; the live smoke test can complete one decision when explicitly enabled.

### Phase 6: functional React game

- Build setup, table layout, player/card/coin presentation, public activity feed, all human decision controls, winner flow, and WebSocket state synchronization.
- Complete full games with placeholder styling before adding elaborate animation.

Exit criteria: a user can play a complete local human-vs-AI match and watch a complete AI-only match through the browser.

### Phase 7: game feel and diagnostics

- Add card, coin, turn, reveal, exchange, and elimination animations.
- Add spectator pause, step, 1x, 2x, and instant controls.
- Add the hidden developer panel and API failure/retry experience.
- Apply the intentional parchment/ink placeholder theme and reduced-motion behavior.

Exit criteria: all chosen v1 interactions are clear and responsive; diagnostics expose the agreed data without secrets; browser tests cover critical flows.

### Phase 8: final verification and handoff

- Run formatting, linting, typing, unit, property, API, frontend, end-to-end, and long stress tests.
- Audit hidden-information boundaries and environment-secret handling.
- Verify setup and play manually for 2, 3, and 6 seats.
- Finalize README setup, troubleshooting, architecture summary, and known limitations.

Exit criteria: every v1 definition-of-done item is satisfied and a clean clone can be started from documented instructions.

## 14. Acceptance checklist

### Rules

- [ ] Base Coup rules are implemented for 2–6 players.
- [ ] Published two-player setup and starting coins are correct.
- [ ] Coup and Assassinate payments, refunds, and blocks are correct.
- [ ] Block eligibility and resolution are correct.
- [ ] Players choose lost influence and Exchange cards.
- [ ] Challenge ordering and claim replacement are correct.
- [ ] Assassination double-loss cases are correct.
- [ ] Cards and coins are conserved in every reachable state.

### Agents and privacy

- [ ] Every AI decision uses the OpenAI Responses API.
- [ ] Structured output can select only an engine-provided legal option.
- [ ] All v1 agents share one versioned prompt and strategy.
- [ ] Each agent sees only its own hidden information and public history.
- [ ] Failure never produces an automatic or heuristic fallback move.
- [ ] Manual retry repeats the unchanged pending decision safely.
- [ ] Diagnostics contain the agreed data and no credentials.

### Product

- [ ] Human-vs-AI works with 1–5 AI opponents.
- [ ] AI-only works with 2–6 AI players.
- [ ] Every human response is explicitly prompted without a timer.
- [ ] AI-only play has pause, step, 1x, 2x, and instant controls.
- [ ] The developer panel is complete, hideable, and warns about spoilers.
- [ ] The interface is animated, laptop-friendly, and usable with reduced motion.
- [ ] The app works locally without authentication or persistence.

### Quality

- [ ] Unit, property, application, adapter, API, component, and end-to-end tests pass.
- [ ] The 10,000-game headless stress suite completes successfully.
- [ ] Formatting, linting, and type checking pass.
- [ ] Setup, environment configuration, and run commands are documented.

## 15. Explicitly deferred work

The following are future directions, not unfinished v1 requirements:

- Freeform table dialogue, accusations, negotiation, threats, and character voices.
- Multiple prompts, strategy profiles, or distinct personalities per seat.
- Per-seat model selection and multiple OpenAI model comparisons.
- Other model providers or local models behind the provider interface.
- Persistent agents, cross-game memory, learning, ratings, or evolution.
- Batch LLM evaluation, automated tournaments, win-rate dashboards, and cost comparisons.
- Saved games, replay files, JSON export/import, transcript downloads, and databases.
- Accounts, authentication, remote multiplayer, hosted deployment, and mobile layouts.
- Final Renaissance woodcut artwork, art-generation pipeline, sound, and music.
- Expansions, Inquisitor, alternate roles, and house rules.
- Public release, commercialization, naming, trademark, and licensing work.

## 16. Principal risks and mitigations

### LLM latency

A six-player game may require many sequential calls because every eligible AI receives genuine challenge and block decisions in clockwise order. Keep prompts and outputs compact, start with low reasoning effort, show clear thinking indicators, and provide spectator pacing controls. Do not weaken the genuine-decision requirement with heuristic passes.

### Rules regressions

The original simulator demonstrated how easily challenge/block behavior can be inverted. Centralize transitions in one engine, express every response as a typed decision, and require the rule matrix plus conservation properties to pass before integrating OpenAI or UI code.

### Hidden-information leakage

Never construct agent prompts from full game-state serialization. Build explicit seat projections and test them recursively. Treat developer diagnostics as a separate, spoiler-marked local surface.

### Model/API drift

Keep model configuration external and isolate the OpenAI adapter. Version the prompt and capture the actual model name in diagnostics. Later experiments can pin snapshots without changing rules or UI code.

### Animation/state disagreement

The backend remains authoritative and every accepted transition increments a state version. The frontend may animate queued events, but it must reconcile to the latest snapshot and never infer game outcomes locally.

### Scope expansion

Dialogue, artwork, persistence, provider abstraction beyond the initial interface, and tournament analytics are compelling but deliberately deferred. Complete the engine, one-agent strategy, and full playable loop before adding them.
