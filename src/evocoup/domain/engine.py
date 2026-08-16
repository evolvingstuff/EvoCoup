"""Deterministic, provider-independent Coup rules engine."""

from __future__ import annotations

import random
from copy import deepcopy
from itertools import combinations
from typing import Any, ClassVar

from evocoup.domain.decisions import Decision, DecisionError, DecisionRequest, LegalOption
from evocoup.domain.enums import (
    ActionType,
    ClaimKind,
    Continuation,
    DecisionKind,
    EventType,
    GamePhase,
    Role,
)
from evocoup.domain.events import GameEvent
from evocoup.domain.invariants import assert_valid_state
from evocoup.domain.models import (
    Card,
    CardReplacement,
    GameState,
    Influence,
    PendingAction,
    PendingBlock,
    PendingChallenge,
    PendingInfluenceLoss,
    PlayerState,
)
from evocoup.domain.views import DeveloperGameView, PublicGameView, SeatGameView


class GameEngine:
    """Owns all state changes and legal-decision enumeration for one match."""

    TREASURY_COINS: ClassVar[int] = 50
    ACTION_ROLES: ClassVar[dict[ActionType, Role]] = {
        ActionType.TAX: Role.DUKE,
        ActionType.ASSASSINATE: Role.ASSASSIN,
        ActionType.EXCHANGE: Role.AMBASSADOR,
        ActionType.STEAL: Role.CAPTAIN,
    }
    ACTION_COSTS: ClassVar[dict[ActionType, int]] = {
        ActionType.COUP: 7,
        ActionType.ASSASSINATE: 3,
    }

    def __init__(self, state: GameState, rng: random.Random) -> None:
        self.state = state
        self._rng = rng
        self._emitted: list[GameEvent] = []

    @classmethod
    def new(
        cls,
        player_names: list[str],
        *,
        seed: int | None = None,
        game_id: str = "game",
        two_player_variant: bool = True,
    ) -> GameEngine:
        """Create a new two-to-six player game."""

        if not 2 <= len(player_names) <= 6:
            raise ValueError("Coup requires between 2 and 6 players")
        if len(set(player_names)) != len(player_names):
            raise ValueError("player names must be unique")

        rng = random.Random(seed)
        players = [
            PlayerState(id=f"player-{index + 1}", name=name, seat=index, coins=2)
            for index, name in enumerate(player_names)
        ]
        starting_player = rng.choice(players)
        if len(players) == 2:
            starting_player.coins = 1

        cards = cls._make_cards()
        setup_options: dict[str, list[Card]] = {}
        setup_queue: list[str] = []
        out_of_play: dict[str, list[Card]] = {player.id: [] for player in players}

        if len(players) == 2 and two_player_variant:
            sets = [
                [card for card in cards if card.id.endswith(f"-{copy_number}")]
                for copy_number in range(1, 4)
            ]
            rng.shuffle(sets)
            setup_order = cls._clockwise_ids(players, starting_player.id, include_start=True)
            for player_id, card_set in zip(setup_order, sets[:2], strict=True):
                rng.shuffle(card_set)
                setup_options[player_id] = card_set
            setup_queue = setup_order
            court_deck = sets[2]
            rng.shuffle(court_deck)
            phase = GamePhase.SETUP_SELECTION
        else:
            rng.shuffle(cards)
            for _ in range(2):
                for player in players:
                    player.influences.append(Influence(card=cards.pop()))
            court_deck = cards
            phase = GamePhase.AWAIT_ACTION

        state = GameState(
            game_id=game_id,
            seed=seed,
            players=players,
            court_deck=court_deck,
            treasury=cls.TREASURY_COINS - sum(player.coins for player in players),
            starting_player_id=starting_player.id,
            active_player_id=starting_player.id,
            phase=phase,
            setup_options=setup_options,
            setup_queue=setup_queue,
            out_of_play=out_of_play,
        )
        engine = cls(state, rng)
        engine._emit(
            EventType.GAME_STARTED,
            f"A {len(players)}-player game was created.",
            details={
                "player_count": len(players),
                "two_player_variant": phase is GamePhase.SETUP_SELECTION,
            },
        )
        if phase is GamePhase.AWAIT_ACTION:
            engine._emit_turn_started()
        assert_valid_state(state)
        return engine

    @staticmethod
    def _make_cards() -> list[Card]:
        return [
            Card(id=f"{role.value}-{copy_number}", role=role)
            for copy_number in range(1, 4)
            for role in Role
        ]

    @staticmethod
    def _clockwise_ids(
        players: list[PlayerState],
        after_player_id: str,
        *,
        include_start: bool = False,
    ) -> list[str]:
        start_index = next(
            index for index, player in enumerate(players) if player.id == after_player_id
        )
        offset_start = 0 if include_start else 1
        return [
            players[(start_index + offset) % len(players)].id
            for offset in range(offset_start, len(players) + offset_start)
        ]

    def pending_decision(self) -> DecisionRequest | None:
        """Return the one decision needed to advance, if any."""

        state = self.state
        if state.phase is GamePhase.FINISHED:
            return None

        if state.phase is GamePhase.SETUP_SELECTION:
            player_id = self._queue_head(state.setup_queue, "setup")
            setup_options = tuple(
                LegalOption(
                    id=f"setup:{card.id}",
                    label=f"Keep {card.role.value.title()}",
                    data={"card_id": card.id, "role": card.role.value},
                )
                for card in state.setup_options[player_id]
            )
            return self._request(
                player_id,
                DecisionKind.SETUP_CARD,
                "Choose one character from your private five-card set.",
                setup_options,
            )

        if state.phase is GamePhase.AWAIT_ACTION:
            player = state.player(state.active_player_id)
            return self._request(
                player.id,
                DecisionKind.ACTION,
                "Choose your action."
                if player.name == "You"
                else f"Choose {player.name}'s action.",
                tuple(self._action_options(player)),
            )

        if state.phase is GamePhase.ACTION_CHALLENGE:
            player_id = self._queue_head(state.response_queue, "action challenge")
            return self._action_challenge_request(player_id)

        if state.phase is GamePhase.BLOCK_WINDOW:
            player_id = self._queue_head(state.response_queue, "block")
            return self._block_request(player_id)

        if state.phase is GamePhase.BLOCK_CHALLENGE:
            player_id = self._queue_head(state.response_queue, "block challenge")
            return self._block_challenge_request(player_id)

        if state.phase is GamePhase.CLAIM_RESPONSE:
            challenge = self._require_challenge()
            claimant = state.player(challenge.claimant_id)
            claim_options: list[LegalOption] = []
            if claimant.has_role(challenge.role):
                claim_options.append(
                    LegalOption(
                        "claim:prove",
                        f"Reveal {challenge.role.value.title()} and draw a replacement",
                    )
                )
            claim_options.append(LegalOption("claim:concede", "Concede the challenge"))
            return self._request(
                claimant.id,
                DecisionKind.CLAIM_RESPONSE,
                f"Prove or concede the {challenge.role.value.title()} claim.",
                tuple(claim_options),
            )

        if state.phase is GamePhase.INFLUENCE_LOSS:
            pending_loss = self._require_influence_loss()
            player = state.player(pending_loss.player_id)
            influence_options = tuple(
                LegalOption(
                    id=f"influence:{influence.card.id}",
                    label=f"Reveal {influence.card.role.value.title()}",
                    data={
                        "card_id": influence.card.id,
                        "role": influence.card.role.value,
                    },
                )
                for influence in player.hidden_influences
            )
            return self._request(
                player.id,
                DecisionKind.LOSE_INFLUENCE,
                f"{pending_loss.reason}. Choose an influence to reveal.",
                influence_options,
            )

        if state.phase is GamePhase.EXCHANGE:
            action = self._require_action()
            player = state.player(action.actor_id)
            available = [influence.card for influence in player.hidden_influences]
            available.extend(state.exchange_drawn)
            keep_count = len(player.hidden_influences)
            exchange_options: list[LegalOption] = []
            seen_role_sets: set[tuple[str, ...]] = set()
            for kept in combinations(available, keep_count):
                roles = tuple(sorted(card.role.value for card in kept))
                if roles in seen_role_sets:
                    continue
                seen_role_sets.add(roles)
                kept_ids = tuple(sorted(card.id for card in kept))
                role_label = ", ".join(role.title() for role in roles)
                exchange_options.append(
                    LegalOption(
                        id=f"exchange:{','.join(kept_ids)}",
                        label=f"Keep {role_label}",
                        data={"card_ids": kept_ids, "roles": list(roles)},
                    )
                )
            return self._request(
                player.id,
                DecisionKind.EXCHANGE,
                "Choose which influence cards to keep.",
                tuple(exchange_options),
            )

        raise RuntimeError(f"unhandled game phase: {state.phase}")

    def pending_response_decisions(self) -> tuple[DecisionRequest, ...]:
        """Return the current response window as independent, read-only requests."""

        if self.state.phase is GamePhase.ACTION_CHALLENGE:
            factory = self._action_challenge_request
        elif self.state.phase is GamePhase.BLOCK_WINDOW:
            factory = self._block_request
        elif self.state.phase is GamePhase.BLOCK_CHALLENGE:
            factory = self._block_challenge_request
        else:
            return ()
        return tuple(factory(player_id) for player_id in self.state.response_queue)

    def decision_view(self, request: DecisionRequest) -> SeatGameView:
        """Project one player's private view for an explicitly prepared request."""

        from evocoup.domain.views import seat_view

        return seat_view(self.state, request.player_id, request)

    def public_view(self) -> PublicGameView:
        """Return a projection containing only public game information."""

        from evocoup.domain.views import public_view

        return public_view(self.state)

    def seat_view(self, player_id: str) -> SeatGameView:
        """Return public information plus one player's private knowledge."""

        from evocoup.domain.views import seat_view

        return seat_view(self.state, player_id, self.pending_decision())

    def developer_view(self) -> DeveloperGameView:
        """Return a defensive full-state copy for explicit local diagnostics."""

        from evocoup.domain.views import developer_view

        return developer_view(self.state, self.pending_decision())

    def apply_decision(self, decision: Decision) -> tuple[GameEvent, ...]:
        """Validate and atomically apply one external decision."""

        request = self.pending_decision()
        if request is None:
            raise DecisionError("the game does not have a pending decision")
        if decision.request_id != request.id:
            raise DecisionError("decision request is stale or does not match")
        if decision.state_version != self.state.version:
            raise DecisionError("decision state version is stale")
        if decision.player_id != request.player_id:
            raise DecisionError("decision was submitted for the wrong player")
        try:
            option = next(option for option in request.options if option.id == decision.option_id)
        except StopIteration as error:
            raise DecisionError("option is not legal for the pending decision") from error

        state_snapshot = deepcopy(self.state)
        random_snapshot = self._rng.getstate()
        self._emitted = []
        try:
            self._dispatch(request.kind, option)
            self.state.version += 1
            assert_valid_state(self.state)
        except Exception:
            self.state = state_snapshot
            self._rng.setstate(random_snapshot)
            self._emitted = []
            raise
        return tuple(self._emitted)

    def _dispatch(self, kind: DecisionKind, option: LegalOption) -> None:
        handlers = {
            DecisionKind.SETUP_CARD: self._choose_setup_card,
            DecisionKind.ACTION: self._choose_action,
            DecisionKind.ACTION_CHALLENGE: self._respond_to_action,
            DecisionKind.BLOCK: self._respond_to_block_window,
            DecisionKind.BLOCK_CHALLENGE: self._respond_to_block_challenge,
            DecisionKind.CLAIM_RESPONSE: self._respond_to_claim,
            DecisionKind.LOSE_INFLUENCE: self._choose_influence,
            DecisionKind.EXCHANGE: self._choose_exchange,
        }
        handlers[kind](option)

    def _request(
        self,
        player_id: str,
        kind: DecisionKind,
        prompt: str,
        options: tuple[LegalOption, ...],
    ) -> DecisionRequest:
        if not options:
            raise RuntimeError(f"decision {kind} has no legal options")
        request_id = f"{self.state.game_id}:{self.state.version}:{kind.value}:{player_id}"
        return DecisionRequest(
            id=request_id,
            state_version=self.state.version,
            player_id=player_id,
            kind=kind,
            prompt=prompt,
            options=options,
        )

    def _action_challenge_request(self, player_id: str) -> DecisionRequest:
        action = self._require_action()
        actor = self.state.player(action.actor_id)
        return self._request(
            player_id,
            DecisionKind.ACTION_CHALLENGE,
            f"Challenge the {self._require_action_role().value.title()} claim made by "
            f"{actor.name}?",
            (
                LegalOption("action-challenge:pass", "Pass"),
                LegalOption("action-challenge:challenge", f"Challenge {actor.name}"),
            ),
        )

    def _block_request(self, player_id: str) -> DecisionRequest:
        action = self._require_action()
        actor = self.state.player(action.actor_id)
        target = self.state.player(action.target_id) if action.target_id is not None else None
        action_label = action.action.value.replace("_", " ").title()
        target_clause = f" targeting {target.name}" if target is not None else ""
        return self._request(
            player_id,
            DecisionKind.BLOCK,
            f"{actor.name} declared {action_label}{target_clause}. Block it?",
            tuple(self._block_options()),
        )

    def _block_challenge_request(self, player_id: str) -> DecisionRequest:
        block = self._require_block()
        blocker = self.state.player(block.blocker_id)
        return self._request(
            player_id,
            DecisionKind.BLOCK_CHALLENGE,
            f"Challenge the {block.claimed_role.value.title()} block made by {blocker.name}?",
            (
                LegalOption("block-challenge:pass", "Pass"),
                LegalOption("block-challenge:challenge", f"Challenge {blocker.name}"),
            ),
        )

    def _action_options(self, player: PlayerState) -> list[LegalOption]:
        opponents = [
            candidate for candidate in self.state.living_players if candidate.id != player.id
        ]
        if player.coins >= 10:
            return [self._action_option(ActionType.COUP, target.id) for target in opponents]

        options: list[LegalOption] = []
        if self.state.treasury >= 1:
            options.append(self._action_option(ActionType.INCOME))
        if self.state.treasury >= 2:
            options.append(self._action_option(ActionType.FOREIGN_AID))
        if player.coins >= 7:
            options.extend(self._action_option(ActionType.COUP, target.id) for target in opponents)
        if self.state.treasury >= 3:
            options.append(self._action_option(ActionType.TAX))
        if player.coins >= 3:
            options.extend(
                self._action_option(ActionType.ASSASSINATE, target.id) for target in opponents
            )
        options.append(self._action_option(ActionType.EXCHANGE))
        options.extend(self._action_option(ActionType.STEAL, target.id) for target in opponents)
        return options

    def _action_option(self, action: ActionType, target_id: str | None = None) -> LegalOption:
        suffix = f":{target_id}" if target_id else ""
        label = action.value.replace("_", " ").title()
        data: dict[str, Any] = {"action": action.value}
        if target_id:
            target = self.state.player(target_id)
            label = f"{label} — {target.name}"
            data["target_id"] = target_id
        return LegalOption(id=f"action:{action.value}{suffix}", label=label, data=data)

    def _block_options(self) -> list[LegalOption]:
        action = self._require_action()
        options = [LegalOption("block:pass", "Do not block")]
        if action.action is ActionType.FOREIGN_AID:
            options.append(LegalOption("block:duke", "Block as Duke", {"role": Role.DUKE.value}))
        elif action.action is ActionType.ASSASSINATE:
            options.append(
                LegalOption("block:contessa", "Block as Contessa", {"role": Role.CONTESSA.value})
            )
        elif action.action is ActionType.STEAL:
            options.extend(
                (
                    LegalOption("block:captain", "Block as Captain", {"role": Role.CAPTAIN.value}),
                    LegalOption(
                        "block:ambassador",
                        "Block as Ambassador",
                        {"role": Role.AMBASSADOR.value},
                    ),
                )
            )
        return options

    def _choose_setup_card(self, option: LegalOption) -> None:
        player_id = self._queue_head(self.state.setup_queue, "setup")
        cards = self.state.setup_options.pop(player_id)
        chosen_id = str(option.data["card_id"])
        chosen = next(card for card in cards if card.id == chosen_id)
        player = self.state.player(player_id)
        player.influences.append(Influence(chosen))
        self.state.out_of_play[player_id].extend(card for card in cards if card.id != chosen_id)
        self.state.setup_queue.pop(0)
        self._emit(
            EventType.SETUP_SELECTION,
            f"{player.name} selected a private starting influence.",
            actor_id=player.id,
        )
        self._emit(
            EventType.SETUP_SELECTION,
            f"You kept {chosen.role.value.title()} from your private setup set.",
            actor_id=player.id,
            details={"card_id": chosen.id, "role": chosen.role.value},
            public=False,
            private_to=player.id,
        )
        if self.state.setup_queue:
            return

        for setup_player in self.state.players:
            setup_player.influences.append(Influence(self.state.court_deck.pop()))
        self._rng.shuffle(self.state.court_deck)
        self.state.phase = GamePhase.AWAIT_ACTION
        self._emit_turn_started()

    def _choose_action(self, option: LegalOption) -> None:
        actor = self.state.player(self.state.active_player_id)
        action = ActionType(option.data["action"])
        target_id = option.data.get("target_id")
        target_id = str(target_id) if target_id is not None else None
        role = self.ACTION_ROLES.get(action)
        cost = self.ACTION_COSTS.get(action, 0)
        self.state.pending_action = PendingAction(
            actor_id=actor.id,
            action=action,
            target_id=target_id,
            claimed_role=role,
            paid_cost=cost,
        )
        target_name = f" targeting {self.state.player(target_id).name}" if target_id else ""
        claim = f" as {role.value.title()}" if role else ""
        self._emit(
            EventType.ACTION_DECLARED,
            f"{actor.name} declared {action.value.replace('_', ' ').title()}{claim}{target_name}.",
            actor_id=actor.id,
            target_id=target_id,
            details={"action": action.value, "claimed_role": role.value if role else None},
        )
        if cost:
            actor.coins -= cost
            self.state.treasury += cost
            self._emit(
                EventType.COST_PAID,
                f"{actor.name} paid {cost} coins.",
                actor_id=actor.id,
                details={"coins": cost},
            )

        if role is not None:
            self.state.response_queue = self._living_clockwise_after(actor.id)
            self.state.phase = GamePhase.ACTION_CHALLENGE
        else:
            self._continue_action()

    def _respond_to_action(self, option: LegalOption) -> None:
        responder_id = self._queue_head(self.state.response_queue, "action challenge")
        action = self._require_action()
        if option.id == "action-challenge:pass":
            self.state.response_queue.pop(0)
            self._emit_pass(responder_id, "the action challenge")
            if not self.state.response_queue:
                self._continue_action()
            return

        actor = self.state.player(action.actor_id)
        challenger = self.state.player(responder_id)
        self.state.pending_challenge = PendingChallenge(
            claimant_id=actor.id,
            challenger_id=challenger.id,
            role=self._require_action_role(),
            claim_kind=ClaimKind.ACTION,
        )
        self.state.response_queue.clear()
        self.state.phase = GamePhase.CLAIM_RESPONSE
        self._emit(
            EventType.CHALLENGE_DECLARED,
            f"{challenger.name} challenged the claim made by {actor.name}.",
            actor_id=challenger.id,
            target_id=actor.id,
            details={"claim_kind": ClaimKind.ACTION.value},
        )

    def _continue_action(self) -> None:
        action = self._require_action()
        if action.target_id is not None and not self.state.player(action.target_id).is_alive:
            self._end_turn()
            return

        if action.action is ActionType.FOREIGN_AID:
            self.state.response_queue = self._living_clockwise_after(action.actor_id)
        elif action.action in {ActionType.ASSASSINATE, ActionType.STEAL}:
            if action.target_id is None:
                raise RuntimeError("targeted action has no target")
            self.state.response_queue = [action.target_id]
        else:
            self._resolve_action()
            return
        self.state.phase = GamePhase.BLOCK_WINDOW

    def _respond_to_block_window(self, option: LegalOption) -> None:
        responder_id = self._queue_head(self.state.response_queue, "block")
        if option.id == "block:pass":
            self.state.response_queue.pop(0)
            self._emit_pass(responder_id, "the block opportunity")
            if not self.state.response_queue:
                self._resolve_action()
            return

        role = Role(option.data["role"])
        blocker = self.state.player(responder_id)
        self.state.pending_block = PendingBlock(blocker_id=blocker.id, claimed_role=role)
        self.state.response_queue = self._living_clockwise_after(blocker.id)
        self.state.phase = GamePhase.BLOCK_CHALLENGE
        action = self._require_action()
        action_label = action.action.value.replace("_", " ").title()
        self._emit(
            EventType.BLOCK_DECLARED,
            f"{blocker.name} claimed {role.value.title()} to block {action_label}.",
            actor_id=blocker.id,
            target_id=action.actor_id,
            details={"role": role.value, "action": action.action.value},
        )

    def _respond_to_block_challenge(self, option: LegalOption) -> None:
        responder_id = self._queue_head(self.state.response_queue, "block challenge")
        block = self._require_block()
        if option.id == "block-challenge:pass":
            self.state.response_queue.pop(0)
            self._emit_pass(responder_id, "the block challenge")
            if not self.state.response_queue:
                self._block_succeeds()
            return

        challenger = self.state.player(responder_id)
        blocker = self.state.player(block.blocker_id)
        self.state.pending_challenge = PendingChallenge(
            claimant_id=blocker.id,
            challenger_id=challenger.id,
            role=block.claimed_role,
            claim_kind=ClaimKind.BLOCK,
        )
        self.state.response_queue.clear()
        self.state.phase = GamePhase.CLAIM_RESPONSE
        self._emit(
            EventType.CHALLENGE_DECLARED,
            f"{challenger.name} challenged the block made by {blocker.name}.",
            actor_id=challenger.id,
            target_id=blocker.id,
            details={"claim_kind": ClaimKind.BLOCK.value},
        )

    def _respond_to_claim(self, option: LegalOption) -> None:
        challenge = self._require_challenge()
        claimant = self.state.player(challenge.claimant_id)
        challenger = self.state.player(challenge.challenger_id)

        if option.id == "claim:prove":
            matching_index = next(
                index
                for index, influence in enumerate(claimant.influences)
                if not influence.revealed and influence.card.role is challenge.role
            )
            proven_card = claimant.influences[matching_index].card
            self.state.court_deck.append(proven_card)
            self._rng.shuffle(self.state.court_deck)
            replacement = self.state.court_deck.pop()
            claimant.influences[matching_index] = Influence(replacement)
            self._emit(
                EventType.CLAIM_PROVEN,
                f"{claimant.name} proved the {challenge.role.value.title()} claim.",
                actor_id=claimant.id,
                target_id=challenger.id,
                details={"role": challenge.role.value},
            )
            self._emit(
                EventType.CARD_REPLACED,
                f"{claimant.name} returned the proven card and drew a replacement.",
                actor_id=claimant.id,
            )
            self.state.latest_card_replacement = CardReplacement(
                player_id=claimant.id,
                card=replacement,
                sequence=self.state.next_event_sequence - 1,
            )
            continuation = (
                Continuation.CONTINUE_ACTION
                if challenge.claim_kind is ClaimKind.ACTION
                else Continuation.BLOCK_SUCCEEDS
            )
            self.state.pending_challenge = None
            self._request_influence_loss(
                challenger.id,
                f"You lost a challenge against {claimant.name}",
                continuation,
            )
            return

        self._emit(
            EventType.CLAIM_CONCEDED,
            f"{claimant.name} conceded the {challenge.role.value.title()} claim.",
            actor_id=claimant.id,
            target_id=challenger.id,
            details={"role": challenge.role.value, "claim_kind": challenge.claim_kind.value},
        )
        if challenge.claim_kind is ClaimKind.ACTION:
            self._refund_action_cost()
            continuation = Continuation.END_TURN
        else:
            continuation = Continuation.RESOLVE_ACTION
        self.state.pending_challenge = None
        self._request_influence_loss(
            claimant.id,
            f"You lost a challenge to {challenger.name}",
            continuation,
        )

    def _request_influence_loss(
        self,
        player_id: str,
        reason: str,
        continuation: Continuation,
    ) -> None:
        player = self.state.player(player_id)
        if not player.hidden_influences:
            self._run_continuation(continuation)
            return
        self.state.pending_influence_loss = PendingInfluenceLoss(
            player_id=player_id,
            reason=reason,
            continuation=continuation,
        )
        self.state.phase = GamePhase.INFLUENCE_LOSS

    def _choose_influence(self, option: LegalOption) -> None:
        pending_loss = self._require_influence_loss()
        player = self.state.player(pending_loss.player_id)
        card_id = str(option.data["card_id"])
        influence = next(
            influence for influence in player.hidden_influences if influence.card.id == card_id
        )
        influence.revealed = True
        self._emit(
            EventType.INFLUENCE_LOST,
            f"{player.name} revealed {influence.card.role.value.title()} and lost an influence.",
            actor_id=player.id,
            details={"card_id": influence.card.id, "role": influence.card.role.value},
        )
        continuation = pending_loss.continuation
        self.state.pending_influence_loss = None
        if not player.is_alive:
            returned_coins = player.coins
            self.state.treasury += returned_coins
            player.coins = 0
            eliminated_message = (
                f"You were eliminated and returned {returned_coins} coins."
                if player.name == "You"
                else f"{player.name} was eliminated and returned {returned_coins} coins."
            )
            self._emit(
                EventType.PLAYER_ELIMINATED,
                eliminated_message,
                actor_id=player.id,
                details={"returned_coins": returned_coins},
            )
        if self._finish_if_won():
            return
        self._run_continuation(continuation)

    def _run_continuation(self, continuation: Continuation) -> None:
        if continuation is Continuation.END_TURN:
            self._end_turn()
        elif continuation is Continuation.CONTINUE_ACTION:
            self._continue_action()
        elif continuation is Continuation.RESOLVE_ACTION:
            self._resolve_action()
        elif continuation is Continuation.BLOCK_SUCCEEDS:
            self._block_succeeds()
        else:
            raise RuntimeError(f"unknown continuation: {continuation}")

    def _resolve_action(self) -> None:
        action = self._require_action()
        actor = self.state.player(action.actor_id)
        target = self.state.player(action.target_id) if action.target_id else None

        if action.action is ActionType.INCOME:
            self._take_from_treasury(actor, 1)
            message = f"{actor.name} took 1 coin as Income."
        elif action.action is ActionType.FOREIGN_AID:
            self._take_from_treasury(actor, 2)
            message = f"{actor.name} took 2 coins as Foreign Aid."
        elif action.action is ActionType.TAX:
            self._take_from_treasury(actor, 3)
            message = f"{actor.name} took 3 coins as Tax."
        elif action.action is ActionType.STEAL:
            if target is None or not target.is_alive:
                self._end_turn()
                return
            amount = min(2, target.coins)
            target.coins -= amount
            actor.coins += amount
            message = f"{actor.name} stole {amount} coins from {target.name}."
        elif action.action in {ActionType.COUP, ActionType.ASSASSINATE}:
            if target is None or not target.is_alive:
                self._end_turn()
                return
            label = "a Coup" if action.action is ActionType.COUP else "an Assassination"
            self._emit(
                EventType.ACTION_RESOLVED,
                f"The {label} by {actor.name} against {target.name} succeeded.",
                actor_id=actor.id,
                target_id=target.id,
                details={"action": action.action.value},
            )
            self._request_influence_loss(
                target.id,
                f"You were targeted by {label}",
                Continuation.END_TURN,
            )
            return
        elif action.action is ActionType.EXCHANGE:
            if len(self.state.court_deck) < 2:
                raise RuntimeError("the Court deck does not contain two cards for Exchange")
            self.state.exchange_drawn = [self.state.court_deck.pop(), self.state.court_deck.pop()]
            self.state.phase = GamePhase.EXCHANGE
            self._emit(
                EventType.EXCHANGE_STARTED,
                f"{actor.name} drew two cards from the Court deck.",
                actor_id=actor.id,
            )
            return
        else:
            raise RuntimeError(f"unhandled action: {action.action}")

        self._emit(
            EventType.ACTION_RESOLVED,
            message,
            actor_id=actor.id,
            target_id=target.id if target else None,
            details={"action": action.action.value},
        )
        self._end_turn()

    def _choose_exchange(self, option: LegalOption) -> None:
        action = self._require_action()
        player = self.state.player(action.actor_id)
        hidden = player.hidden_influences
        available = [influence.card for influence in hidden]
        available.extend(self.state.exchange_drawn)
        keep_ids = set(option.data["card_ids"])
        kept = [card for card in available if card.id in keep_ids]
        returned = [card for card in available if card.id not in keep_ids]
        if len(kept) != len(hidden) or len(returned) != 2:
            raise RuntimeError("invalid Exchange card counts")

        player.influences = player.revealed_influences + [Influence(card) for card in kept]
        self.state.court_deck.extend(returned)
        self._rng.shuffle(self.state.court_deck)
        self.state.exchange_drawn.clear()
        self._emit(
            EventType.EXCHANGE_COMPLETED,
            f"{player.name} returned two cards to the Court deck.",
            actor_id=player.id,
        )
        self._end_turn()

    def _block_succeeds(self) -> None:
        action = self._require_action()
        block = self._require_block()
        blocker = self.state.player(block.blocker_id)
        self._emit(
            EventType.BLOCK_SUCCEEDED,
            f"The {block.claimed_role.value.title()} block by {blocker.name} succeeded.",
            actor_id=blocker.id,
            target_id=action.actor_id,
            details={"role": block.claimed_role.value, "action": action.action.value},
        )
        self._end_turn()

    def _refund_action_cost(self) -> None:
        action = self._require_action()
        if not action.paid_cost:
            return
        actor = self.state.player(action.actor_id)
        actor.coins += action.paid_cost
        self.state.treasury -= action.paid_cost
        self._emit(
            EventType.COST_REFUNDED,
            f"{actor.name} received a refund of {action.paid_cost} coins.",
            actor_id=actor.id,
            details={"coins": action.paid_cost},
        )
        action.paid_cost = 0

    def _end_turn(self) -> None:
        action = self.state.pending_action
        actor_id = action.actor_id if action else self.state.active_player_id
        actor = self.state.player(actor_id)
        turn_ended_message = (
            "Your turn ended." if actor.name == "You" else f"{actor.name}'s turn ended."
        )
        self._emit(EventType.TURN_ENDED, turn_ended_message, actor_id=actor.id)
        self.state.pending_action = None
        self.state.pending_block = None
        self.state.pending_challenge = None
        self.state.pending_influence_loss = None
        self.state.response_queue.clear()
        self.state.exchange_drawn.clear()
        if self._finish_if_won():
            return
        next_player_id = next(
            player_id
            for player_id in self._clockwise_ids(self.state.players, actor_id)
            if self.state.player(player_id).is_alive
        )
        self.state.active_player_id = next_player_id
        self.state.turn += 1
        self.state.phase = GamePhase.AWAIT_ACTION
        self._emit_turn_started()

    def _finish_if_won(self) -> bool:
        living = self.state.living_players
        if len(living) != 1:
            return False
        winner = living[0]
        self.state.winner_id = winner.id
        self.state.phase = GamePhase.FINISHED
        self.state.response_queue.clear()
        self.state.pending_action = None
        self.state.pending_block = None
        self.state.pending_challenge = None
        self.state.pending_influence_loss = None
        self.state.exchange_drawn.clear()
        self._emit(
            EventType.GAME_FINISHED,
            f"{winner.name} won the game.",
            actor_id=winner.id,
        )
        return True

    def _take_from_treasury(self, player: PlayerState, amount: int) -> None:
        if self.state.treasury < amount:
            raise RuntimeError("the treasury does not contain enough coins")
        self.state.treasury -= amount
        player.coins += amount

    def _living_clockwise_after(self, player_id: str) -> list[str]:
        return [
            candidate_id
            for candidate_id in self._clockwise_ids(self.state.players, player_id)
            if candidate_id != player_id and self.state.player(candidate_id).is_alive
        ]

    def _emit_turn_started(self) -> None:
        player = self.state.player(self.state.active_player_id)
        self._emit(
            EventType.TURN_STARTED,
            (
                f"Turn {self.state.turn}: it is your turn."
                if player.name == "You"
                else f"Turn {self.state.turn}: {player.name} acts."
            ),
            actor_id=player.id,
        )

    def _emit_pass(self, player_id: str, window: str) -> None:
        player = self.state.player(player_id)
        self._emit(
            EventType.RESPONSE_PASSED,
            f"{player.name} passed on {window}.",
            actor_id=player.id,
            details={"window": window},
        )

    def _emit(
        self,
        event_type: EventType,
        message: str,
        *,
        actor_id: str | None = None,
        target_id: str | None = None,
        details: dict[str, Any] | None = None,
        public: bool = True,
        private_to: str | None = None,
    ) -> None:
        event = GameEvent(
            sequence=self.state.next_event_sequence,
            turn=self.state.turn,
            type=event_type,
            message=message,
            actor_id=actor_id,
            target_id=target_id,
            details=details or {},
            public=public,
            private_to=private_to,
        )
        self.state.next_event_sequence += 1
        if public:
            self.state.history.append(event)
        self._emitted.append(event)

    def _require_action(self) -> PendingAction:
        if self.state.pending_action is None:
            raise RuntimeError("game phase requires a pending action")
        return self.state.pending_action

    def _require_action_role(self) -> Role:
        action = self._require_action()
        if action.claimed_role is None:
            raise RuntimeError("pending action does not contain a character claim")
        return action.claimed_role

    def _require_block(self) -> PendingBlock:
        if self.state.pending_block is None:
            raise RuntimeError("game phase requires a pending block")
        return self.state.pending_block

    def _require_challenge(self) -> PendingChallenge:
        if self.state.pending_challenge is None:
            raise RuntimeError("game phase requires a pending challenge")
        return self.state.pending_challenge

    def _require_influence_loss(self) -> PendingInfluenceLoss:
        if self.state.pending_influence_loss is None:
            raise RuntimeError("game phase requires a pending influence loss")
        return self.state.pending_influence_loss

    @staticmethod
    def _queue_head(queue: list[str], label: str) -> str:
        if not queue:
            raise RuntimeError(f"{label} phase has an empty response queue")
        return queue[0]
