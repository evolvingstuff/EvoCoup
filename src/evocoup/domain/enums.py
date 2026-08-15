"""Enumerations used by the Coup domain model."""

from enum import StrEnum


class Role(StrEnum):
    DUKE = "duke"
    ASSASSIN = "assassin"
    CAPTAIN = "captain"
    AMBASSADOR = "ambassador"
    CONTESSA = "contessa"


class ActionType(StrEnum):
    INCOME = "income"
    FOREIGN_AID = "foreign_aid"
    COUP = "coup"
    TAX = "tax"
    ASSASSINATE = "assassinate"
    EXCHANGE = "exchange"
    STEAL = "steal"


class DecisionKind(StrEnum):
    SETUP_CARD = "setup_card"
    ACTION = "action"
    ACTION_CHALLENGE = "action_challenge"
    BLOCK = "block"
    BLOCK_CHALLENGE = "block_challenge"
    CLAIM_RESPONSE = "claim_response"
    LOSE_INFLUENCE = "lose_influence"
    EXCHANGE = "exchange"


class GamePhase(StrEnum):
    SETUP_SELECTION = "setup_selection"
    AWAIT_ACTION = "await_action"
    ACTION_CHALLENGE = "action_challenge"
    BLOCK_WINDOW = "block_window"
    BLOCK_CHALLENGE = "block_challenge"
    CLAIM_RESPONSE = "claim_response"
    INFLUENCE_LOSS = "influence_loss"
    EXCHANGE = "exchange"
    FINISHED = "finished"


class ClaimKind(StrEnum):
    ACTION = "action"
    BLOCK = "block"


class Continuation(StrEnum):
    END_TURN = "end_turn"
    CONTINUE_ACTION = "continue_action"
    RESOLVE_ACTION = "resolve_action"
    BLOCK_SUCCEEDS = "block_succeeds"


class EventType(StrEnum):
    GAME_STARTED = "game_started"
    SETUP_SELECTION = "setup_selection"
    TURN_STARTED = "turn_started"
    ACTION_DECLARED = "action_declared"
    COST_PAID = "cost_paid"
    COST_REFUNDED = "cost_refunded"
    RESPONSE_PASSED = "response_passed"
    CHALLENGE_DECLARED = "challenge_declared"
    CLAIM_PROVEN = "claim_proven"
    CLAIM_CONCEDED = "claim_conceded"
    CARD_REPLACED = "card_replaced"
    BLOCK_DECLARED = "block_declared"
    BLOCK_SUCCEEDED = "block_succeeded"
    ACTION_RESOLVED = "action_resolved"
    INFLUENCE_LOST = "influence_lost"
    PLAYER_ELIMINATED = "player_eliminated"
    EXCHANGE_STARTED = "exchange_started"
    EXCHANGE_COMPLETED = "exchange_completed"
    TURN_ENDED = "turn_ended"
    GAME_FINISHED = "game_finished"
