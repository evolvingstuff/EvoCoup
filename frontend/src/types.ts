export type Role = "duke" | "assassin" | "captain" | "ambassador" | "contessa";
export type MatchMode = "human_vs_ai" | "ai_only";
export type MatchStatus =
  | "running"
  | "paused"
  | "waiting_for_human"
  | "agent_error"
  | "finished";

export interface GameEvent {
  sequence: number;
  turn: number;
  type: string;
  message: string;
  actor_id: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

export interface PlayerView {
  id: string;
  name: string;
  seat: number;
  coins: number;
  hidden_influence_count: number;
  revealed_roles: Role[];
  is_alive: boolean;
}

export interface PublicGameView {
  game_id: string;
  version: number;
  turn: number;
  phase: string;
  active_player_id: string;
  starting_player_id: string;
  players: PlayerView[];
  court_deck_count: number;
  treasury: number;
  pending_action: {
    actor_id: string;
    action: string;
    target_id: string | null;
    claimed_role: Role | null;
  } | null;
  pending_block: { blocker_id: string; claimed_role: Role } | null;
  pending_challenge: {
    claimant_id: string;
    challenger_id: string;
    role: Role;
    claim_kind: "action" | "block";
  } | null;
  winner_id: string | null;
  history: GameEvent[];
}

export interface PrivateCard {
  id: string;
  role: Role;
}

export interface LegalOption {
  id: string;
  label: string;
  data: Record<string, unknown>;
}

export interface DecisionRequest {
  id: string;
  state_version: number;
  player_id: string;
  kind: string;
  prompt: string;
  options: LegalOption[];
}

export interface SeatGameView {
  public: PublicGameView;
  player_id: string;
  hidden_cards: PrivateCard[];
  known_setup_discards: PrivateCard[];
  setup_choices: PrivateCard[];
  exchange_cards: PrivateCard[];
  latest_card_replacement?: { sequence: number; card: PrivateCard } | null;
  pending_decision: DecisionRequest | null;
}

export interface MatchPayload {
  mode: MatchMode;
  status: MatchStatus;
  human_player_id: string | null;
  thinking_player_id: string | null;
  thinking_decision_kind: string | null;
  thinking_players: { player_id: string; decision_kind: string }[];
  standings: { name: string; games: number; wins: number }[];
  last_error: string | null;
  view: PublicGameView | SeatGameView;
  pending_human_decision: DecisionRequest | null;
}

export interface HealthPayload {
  status: string;
  current_match: boolean;
  openai_configured: boolean;
  model: string;
}

export function isSeatView(view: MatchPayload["view"]): view is SeatGameView {
  return "public" in view;
}

export function gameView(match: MatchPayload): PublicGameView {
  return isSeatView(match.view) ? match.view.public : match.view;
}
