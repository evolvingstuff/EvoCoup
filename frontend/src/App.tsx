import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ApiError, api } from "./api";
import {
  gameView,
  isSeatView,
  type DecisionRequest,
  type GameEvent,
  type HealthPayload,
  type LegalOption,
  type MatchMode,
  type MatchPayload,
  type PlayerView,
  type PrivateCard,
  type PublicGameView,
  type Role,
} from "./types";

const RESULT_DURATION_MS = 2100;
const RESULT_ENTRY_DELAY_MS = 1400;
const THREAD_DRAW_DURATION_MS = 1400;

const ROLE_LABELS: Record<Role, string> = {
  duke: "Duke",
  assassin: "Assassin",
  captain: "Captain",
  ambassador: "Ambassador",
  contessa: "Contessa",
};

const ROLE_RULES: Record<Role, string> = {
  duke: "Tax: take 3 coins. May also block another player's Foreign Aid.",
  assassin: "Assassinate: pay 3 coins to make a target lose one influence.",
  captain: "Steal: take up to 2 coins from a target. May also block Steal.",
  ambassador: "Exchange: draw 2 Court cards, then return cards. May also block Steal.",
  contessa: "May block an assassination targeting you.",
};

const ACTION_MARKS: Record<string, string> = {
  income: "+1",
  foreign_aid: "+2",
  coup: "♜",
  tax: "Ⅲ",
  assassinate: "†",
  exchange: "⇄",
  steal: "◈",
};

const ACTION_ROLES: Partial<Record<string, Role>> = {
  tax: "duke",
  assassinate: "assassin",
  exchange: "ambassador",
  steal: "captain",
};

const ACTION_DESCRIPTIONS: Record<string, string> = {
  income: "Take 1 coin. This action cannot be blocked or challenged.",
  foreign_aid: "Take 2 coins. Any opponent may block with a Duke claim.",
  coup: "Pay 7 coins; the target loses one influence. Cannot be blocked or challenged.",
  tax: "Claim Duke and take 3 coins. The claim may be challenged; the action cannot be blocked.",
  assassinate: "Claim Assassin and pay 3 coins; the target loses one influence. May be challenged or blocked with Contessa.",
  exchange: "Claim Ambassador, draw 2 Court cards, then return cards to restore your hand size. May be challenged.",
  steal: "Claim Captain and take up to 2 coins from the target. May be challenged or blocked with Captain or Ambassador.",
};

const ACTION_RESULT_LABELS: Record<string, string> = {
  income: "Income collected",
  foreign_aid: "Foreign Aid collected",
  coup: "Coup succeeded",
  tax: "Tax collected",
  assassinate: "Assassination succeeded",
  exchange: "Exchange complete",
  steal: "Steal succeeded",
};

const CHALLENGEABLE_UNBLOCKABLE_ACTIONS = new Set(["tax", "exchange"]);

type ActionProvenance = {
  kind: "basic" | "card" | "bluff";
  role: Role | null;
  explanation: string;
};

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function thinkingCopy(decisionKind: string | null): string {
  switch (decisionKind) {
    case "setup_card":
      return "choosing a starting card…";
    case "action":
      return "choosing an action…";
    case "action_challenge":
    case "block_challenge":
      return "thinking of challenging…";
    case "block":
      return "thinking of blocking…";
    case "claim_response":
      return "answering a challenge…";
    case "lose_influence":
      return "choosing a card to reveal…";
    case "exchange":
      return "choosing cards…";
    default:
      return "thinking…";
  }
}

function isMissingMatch(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function roleImage(role: Role): string {
  return `/images/cards/${role}.png`;
}

function playerLabel(player: PlayerView): string {
  return player.name === "You" ? "You" : `Seat ${String(player.seat + 1).padStart(2, "0")}`;
}

function displayGameText(text: string, view: PublicGameView): string {
  return view.players.reduce(
    (copy, player) => copy.replaceAll(player.name, playerLabel(player)),
    text,
  );
}

function blockDecisionPrompt(view: PublicGameView): string | null {
  const action = view.pending_action;
  if (!action) return null;
  const actor = view.players.find((player) => player.id === action.actor_id);
  const target = action.target_id
    ? view.players.find((player) => player.id === action.target_id)
    : null;
  const actorName = actor ? playerLabel(actor) : "The acting player";
  const targetName = target ? playerLabel(target).toLowerCase() : "the target";
  if (action.action === "steal") {
    return `${actorName} is trying to steal up to 2 coins from ${targetName}. Block the Steal?`;
  }
  if (action.action === "assassinate") {
    return `${actorName} is trying to assassinate ${targetName}. Block the Assassination?`;
  }
  if (action.action === "foreign_aid") {
    return `${actorName} is attempting to take 2 coins as Foreign Aid. Block it?`;
  }
  return `${actorName} declared ${titleCase(action.action)}. Block it?`;
}

function influenceLossReason(prompt: string, view: PublicGameView): string | null {
  const orderedSuffix = ". Choose an influence to reveal.";
  if (prompt.endsWith(orderedSuffix)) {
    return displayGameText(prompt.slice(0, -orderedSuffix.length), view);
  }
  const legacyPrefix = "Choose an influence to reveal: ";
  if (prompt.startsWith(legacyPrefix)) {
    const reason = prompt.slice(legacyPrefix.length).replace(/\.$/, "");
    const completeReason = /^lost\b/i.test(reason)
      ? `You ${reason}`
      : /^targeted\b/i.test(reason)
        ? `You were ${reason}`
        : reason;
    return displayGameText(completeReason, view);
  }
  return null;
}

function scatteredValue(index: number, salt: number): number {
  const raw = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return raw - Math.floor(raw);
}

function seatPosition(player: PlayerView, count: number): { x: number; y: number } {
  const angle = Math.PI / 2 + (player.seat * Math.PI * 2) / count;
  return {
    x: 50 + Math.cos(angle) * 40,
    y: 49 + Math.sin(angle) * 37,
  };
}

function inwardOffset(x: number, y: number): { x: number; y: number } {
  const boardAspectRatio = 1586 / 992;
  const towardCenterX = (50 - x) * boardAspectRatio;
  const towardCenterY = 49 - y;
  const magnitude = Math.hypot(towardCenterX, towardCenterY) || 1;
  const unitX = towardCenterX / magnitude;
  const unitY = towardCenterY / magnitude;
  const horizontalDistance = Math.abs(unitX) > 0.001 ? 128 / Math.abs(unitX) : Infinity;
  const verticalDistance = Math.abs(unitY) > 0.001 ? 85 / Math.abs(unitY) : Infinity;
  const distance = Math.min(horizontalDistance, verticalDistance);
  return { x: unitX * distance, y: unitY * distance };
}

type InteractionState = {
  action: NonNullable<PublicGameView["pending_action"]> | null;
  actionSequence: number;
  status: "pending" | "succeeded" | "canceled" | "ended";
  block: PublicGameView["pending_block"];
  challenge: {
    claimant_id: string;
    challenger_id: string;
    claim_kind: "action" | "block";
  } | null;
  actionProgressed: boolean;
  blockProgressed: boolean;
  concludingSequence: number | null;
};

const ACTION_PROGRESS_EVENTS = new Set([
  "challenge_declared",
  "block_declared",
  "block_succeeded",
  "claim_proven",
  "claim_conceded",
  "response_passed",
]);

const BLOCK_PROGRESS_EVENTS = new Set([
  "challenge_declared",
  "block_succeeded",
  "claim_proven",
  "claim_conceded",
  "response_passed",
]);

function interactionState(view: PublicGameView, actionSequence?: number): InteractionState {
  let declaration: GameEvent | null = null;
  let declarationIndex = -1;
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    if (
      view.history[index].type === "action_declared"
      && (actionSequence === undefined || view.history[index].sequence === actionSequence)
    ) {
      declaration = view.history[index];
      declarationIndex = index;
      break;
    }
  }
  let nextDeclarationIndex = view.history.length;
  if (declarationIndex >= 0) {
    for (let index = declarationIndex + 1; index < view.history.length; index += 1) {
      if (view.history[index].type === "action_declared") {
        nextDeclarationIndex = index;
        break;
      }
    }
  }
  let latestDeclarationIndex = -1;
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    if (view.history[index].type === "action_declared") {
      latestDeclarationIndex = index;
      break;
    }
  }
  const isLatestAction = declarationIndex < 0 || declarationIndex === latestDeclarationIndex;
  const action = declaration?.actor_id && typeof declaration.details.action === "string"
    ? {
        actor_id: declaration.actor_id,
        action: declaration.details.action,
        target_id: declaration.target_id,
        claimed_role:
          typeof declaration.details.claimed_role === "string"
          && declaration.details.claimed_role in ROLE_LABELS
            ? declaration.details.claimed_role as Role
            : null,
      }
    : view.pending_action;
  const actionEvents = declarationIndex >= 0
    ? view.history.slice(declarationIndex + 1, nextDeclarationIndex)
    : [];
  const canceledEvent = actionEvents.find(
    (event) => event.type === "block_succeeded"
      || (event.type === "claim_conceded" && event.details.claim_kind === "action"),
  );
  const succeededEvent = actionEvents.find(
    (event) => event.type === "action_resolved"
      || (event.type === "exchange_completed" && event.actor_id === action?.actor_id),
  );
  const canceled = Boolean(canceledEvent);
  const succeeded = Boolean(succeededEvent);
  const ended = view.phase === "finished"
    || view.winner_id !== null
    || actionEvents.some((event) => event.type === "turn_ended");
  let blockDeclarationIndex = -1;
  let declaredBlock: PublicGameView["pending_block"] = null;
  for (let index = actionEvents.length - 1; index >= 0; index -= 1) {
    const blockEvent = actionEvents[index];
    if (blockEvent.type === "block_declared") {
      blockDeclarationIndex = index;
      const role = blockEvent.details.role;
      if (blockEvent.actor_id && typeof role === "string" && role in ROLE_LABELS) {
        declaredBlock = {
          blocker_id: blockEvent.actor_id,
          claimed_role: role as Role,
        };
      }
      break;
    }
  }
  const blockEvents = blockDeclarationIndex >= 0
    ? actionEvents.slice(blockDeclarationIndex + 1)
    : [];
  const blockEnded = blockEvents.some(
    (event) => event.type === "block_succeeded"
      || (event.type === "claim_conceded" && event.details.claim_kind === "block"),
  );
  return {
    action,
    actionSequence: declaration?.sequence ?? 0,
    status: canceled ? "canceled" : succeeded ? "succeeded" : ended ? "ended" : "pending",
    block: !blockEnded && !canceled && !succeeded && !ended
      ? (isLatestAction ? view.pending_block : null) ?? declaredBlock
      : null,
    challenge: !ended && isLatestAction && view.pending_challenge
      ? {
          claimant_id: view.pending_challenge.claimant_id,
          challenger_id: view.pending_challenge.challenger_id,
          claim_kind: view.pending_challenge.claim_kind,
        }
      : null,
    actionProgressed: actionEvents.some((event) => ACTION_PROGRESS_EVENTS.has(event.type)),
    blockProgressed: blockEvents.some((event) => BLOCK_PROGRESS_EVENTS.has(event.type)),
    concludingSequence: canceledEvent?.sequence ?? succeededEvent?.sequence ?? null,
  };
}

function playerOutcomesForEvent(
  view: PublicGameView,
  sequence: number | null,
): Map<string, "positive" | "negative"> {
  const outcomes = new Map<string, "positive" | "negative">();
  if (sequence === null) return outcomes;
  const event = view.history.find((candidate) => candidate.sequence === sequence);
  if (!event) return outcomes;
  if (event.type === "action_resolved") {
    if (event.actor_id) outcomes.set(event.actor_id, "positive");
    if (event.target_id) outcomes.set(event.target_id, "negative");
  } else if (event.type === "influence_lost" || event.type === "player_eliminated") {
    if (event.actor_id) outcomes.set(event.actor_id, "negative");
  }
  return outcomes;
}

function revealedRolesAtPresentation(
  player: PlayerView,
  view: PublicGameView,
  sequence: number | null,
): Role[] {
  if (sequence === null) return player.revealed_roles;
  const visible = [...player.revealed_roles];
  for (const event of view.history) {
    if (
      event.sequence <= sequence
      || event.type !== "influence_lost"
      || event.actor_id !== player.id
    ) continue;
    const role = event.details.role;
    if (typeof role !== "string" || !(role in ROLE_LABELS)) continue;
    const index = visible.lastIndexOf(role as Role);
    if (index >= 0) visible.splice(index, 1);
  }
  return visible;
}

type CourtResult = {
  sequence: number;
  actionSequence: number;
  label: string;
  kind: "action" | "block" | "challenge" | "replacement" | "reveal" | "loss" | "death" | "winner" | "neutral";
  actorId: string | null;
  action: NonNullable<PublicGameView["pending_action"]>;
  block: PublicGameView["pending_block"];
  blockConcluding: boolean;
  challenge: {
    claimant_id: string;
    challenger_id: string;
    claim_kind: "action" | "block";
  } | null;
  reveal: { playerId: string; role: Role } | null;
  proofReturn: { playerId: string; role: Role; claimKind: "action" | "block" } | null;
  replacement: { playerId: string } | null;
  delayed?: boolean;
};

function courtResultsForLatestAction(view: PublicGameView): CourtResult[] {
  let declarationIndex = -1;
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    if (view.history[index].type === "action_declared") {
      declarationIndex = index;
      break;
    }
  }
  if (declarationIndex < 0) return [];
  const declaration = view.history[declarationIndex];
  const actionActorId = declaration.actor_id;
  const actionName = declaration.details.action;
  if (!actionActorId || typeof actionName !== "string") return [];
  const claimedRole = declaration.details.claimed_role;
  const resultAction: NonNullable<PublicGameView["pending_action"]> = {
    actor_id: actionActorId,
    action: actionName,
    target_id: declaration.target_id,
    claimed_role: typeof claimedRole === "string" && claimedRole in ROLE_LABELS
      ? claimedRole as Role
      : null,
  };
  const actionEvents = view.history.slice(declarationIndex + 1);
  const actionChallengeDeclared = actionEvents.some((event) =>
    event.type === "challenge_declared" && event.details.claim_kind === "action"
  );
  const blockChallengeDeclared = actionEvents.some((event) =>
    event.type === "challenge_declared" && event.details.claim_kind === "block"
  );
  const blockDeclared = actionEvents.some((event) => event.type === "block_declared");
  const lastChallengePass = [...actionEvents].reverse().find((event) =>
    event.type === "response_passed" && event.details.window === "the action challenge"
  );
  const lastBlockPass = [...actionEvents].reverse().find((event) =>
    event.type === "response_passed" && event.details.window === "the block opportunity"
  );
  const lastBlockChallengePass = [...actionEvents].reverse().find((event) =>
    event.type === "response_passed" && event.details.window === "the block challenge"
  );
  const results: CourtResult[] = [];
  let currentBlock: PublicGameView["pending_block"] = null;
  const resultFrame = (
    result: Omit<
      CourtResult,
      "actionSequence" | "actorId" | "action" | "block" | "blockConcluding" | "challenge" | "reveal" | "proofReturn" | "replacement"
    >,
    layers: {
      block?: PublicGameView["pending_block"];
      blockConcluding?: boolean;
      challenge?: CourtResult["challenge"];
      reveal?: CourtResult["reveal"];
      proofReturn?: CourtResult["proofReturn"];
      replacement?: CourtResult["replacement"];
    } = {},
  ): CourtResult => ({
    ...result,
    actionSequence: declaration.sequence,
    actorId: actionActorId,
    action: resultAction,
    block: layers.block ?? null,
    blockConcluding: layers.blockConcluding ?? false,
    challenge: layers.challenge ?? null,
    reveal: layers.reveal ?? null,
    proofReturn: layers.proofReturn ?? null,
    replacement: layers.replacement ?? null,
  });
  let currentChallenge: CourtResult["challenge"] = null;
  for (let index = declarationIndex + 1; index < view.history.length; index += 1) {
    const event = view.history[index];
    if (event.type === "block_declared" && event.actor_id) {
      const role = event.details.role;
      if (typeof role === "string" && role in ROLE_LABELS) {
        currentBlock = { blocker_id: event.actor_id, claimed_role: role as Role };
      }
    }
    if (event.type === "block_succeeded" && !currentBlock && event.actor_id) {
      const role = event.details.role;
      if (typeof role === "string" && role in ROLE_LABELS) {
        currentBlock = { blocker_id: event.actor_id, claimed_role: role as Role };
      }
    }
    if (event.type === "challenge_declared" && event.actor_id && event.target_id) {
      currentChallenge = {
        challenger_id: event.actor_id,
        claimant_id: event.target_id,
        claim_kind: event.details.claim_kind === "block" ? "block" : "action",
      };
    }
    if (
      event.sequence === lastChallengePass?.sequence
      && !actionChallengeDeclared
      && view.phase !== "action_challenge"
    ) {
      results.push(resultFrame({ sequence: event.sequence, label: "No challenges", kind: "neutral" }));
    }
    if (
      event.sequence === lastBlockPass?.sequence
      && !blockDeclared
      && view.phase !== "block_window"
    ) {
      results.push(resultFrame({ sequence: event.sequence, label: "No blocks", kind: "neutral" }));
    }
    if (
      event.sequence === lastBlockChallengePass?.sequence
      && !blockChallengeDeclared
      && view.phase !== "block_challenge"
    ) {
      results.push(resultFrame(
        { sequence: event.sequence, label: "No challenges", kind: "neutral" },
        { block: currentBlock },
      ));
    }
    if (event.type === "block_succeeded") {
      results.push(resultFrame(
        { sequence: event.sequence, label: "Block succeeded", kind: "block" },
        { block: currentBlock, blockConcluding: true },
      ));
    }
    if (event.type === "claim_conceded") {
      results.push(resultFrame({
        sequence: event.sequence,
        label: event.details.claim_kind === "block"
          ? "Block challenge succeeded"
          : "Action challenge succeeded",
        kind: "challenge",
      }, {
        block: event.details.claim_kind === "block" ? currentBlock : null,
        blockConcluding: event.details.claim_kind === "block",
        challenge: currentChallenge,
      }));
    }
    if (event.type === "claim_proven") {
      let challengedBlock = false;
      for (let challengeIndex = index - 1; challengeIndex > declarationIndex; challengeIndex -= 1) {
        const candidate = view.history[challengeIndex];
        if (candidate.type !== "challenge_declared") continue;
        challengedBlock = candidate.details.claim_kind === "block";
        break;
      }
      const provenRole = event.details.role;
      results.push(resultFrame({
        sequence: event.sequence,
        label: challengedBlock ? "Block challenge failed" : "Action challenge failed",
        kind: "challenge",
      }, {
        block: challengedBlock ? currentBlock : null,
        challenge: currentChallenge,
        proofReturn: event.actor_id
          && typeof provenRole === "string"
          && provenRole in ROLE_LABELS
          ? {
              playerId: event.actor_id,
              role: provenRole as Role,
              claimKind: challengedBlock ? "block" : "action",
            }
          : null,
      }));
    }
    if (event.type === "card_replaced" && event.actor_id) {
      const player = view.players.find((candidate) => candidate.id === event.actor_id);
      if (player) {
        results.push(resultFrame({
          sequence: event.sequence,
          label: `${playerLabel(player)} drew a replacement`,
          kind: "replacement",
        }, {
          block: currentBlock,
          challenge: null,
          replacement: { playerId: event.actor_id },
        }));
      }
    }
    if (
      CHALLENGEABLE_UNBLOCKABLE_ACTIONS.has(actionName)
      && (event.type === "action_resolved" || event.type === "exchange_completed")
    ) {
      results.push(resultFrame({
        sequence: event.sequence - 0.01,
        label: "Cannot be blocked",
        kind: "neutral",
      }));
    }
    if (event.type === "exchange_completed") {
      results.push(resultFrame({ sequence: event.sequence, label: "Exchange complete", kind: "action" }));
    }
    if (event.type === "action_resolved" && typeof event.details.action === "string") {
      results.push(resultFrame({
        sequence: event.sequence,
        label: ACTION_RESULT_LABELS[event.details.action]
          ?? `${titleCase(event.details.action)} succeeded`,
        kind: "action",
      }));
    }
    if (event.type === "influence_lost" && event.actor_id) {
      const revealedRole = event.details.role;
      const revealedPlayer = view.players.find((candidate) => candidate.id === event.actor_id);
      if (
        revealedPlayer
        && typeof revealedRole === "string"
        && revealedRole in ROLE_LABELS
      ) {
        results.push(resultFrame({
          sequence: event.sequence - 0.01,
          label: `${playerLabel(revealedPlayer)} revealed ${ROLE_LABELS[revealedRole as Role]}`,
          kind: "reveal",
        }, {
          block: currentBlock,
          challenge: null,
          reveal: { playerId: event.actor_id, role: revealedRole as Role },
        }));
      }
      const eliminated = actionEvents.some(
        (candidate) => candidate.type === "player_eliminated"
          && candidate.actor_id === event.actor_id
          && candidate.sequence > event.sequence,
      );
      const player = view.players.find((candidate) => candidate.id === event.actor_id);
      if (!eliminated && player) {
        results.push(resultFrame({
          sequence: event.sequence,
          label: player.name === "You"
            ? "You lost an influence"
            : `${playerLabel(player)} lost an influence`,
          kind: "loss",
        }));
      }
    }
    if (event.type === "player_eliminated" && event.actor_id) {
      const player = view.players.find((candidate) => candidate.id === event.actor_id);
      if (player) {
        results.push(resultFrame({
          sequence: event.sequence,
          label: player.name === "You" ? "You have died" : `${playerLabel(player)} has died`,
          kind: "death",
        }, { block: currentBlock, challenge: null }));
      }
    }
    if (event.type === "game_finished" && event.actor_id) {
      const player = view.players.find((candidate) => candidate.id === event.actor_id);
      if (player) {
        results.push(resultFrame({
          sequence: event.sequence,
          label: `${playerLabel(player)} wins`,
          kind: "winner",
        }));
      }
    }
  }
  return results;
}

function courtResultsForHistory(view: PublicGameView): CourtResult[] {
  const declarationIndices = view.history.flatMap((event, index) =>
    event.type === "action_declared" ? [index] : []
  );
  return declarationIndices.flatMap((declarationIndex, index) => {
    const nextDeclarationIndex = declarationIndices[index + 1] ?? view.history.length;
    return courtResultsForLatestAction({
      ...view,
      history: view.history.slice(0, nextDeclarationIndex),
      phase: index === declarationIndices.length - 1 ? view.phase : "turn_start",
    });
  });
}

function recentCardReplacement(
  view: PublicGameView,
  playerId: string | null,
): { sequence: number; returnedRole: Role | null } | null {
  if (!playerId) return null;
  const latestSequence = view.history.at(-1)?.sequence ?? 0;
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    const event = view.history[index];
    if (latestSequence - event.sequence > 6) break;
    if (event.type !== "card_replaced" || event.actor_id !== playerId) continue;
    let role: unknown = null;
    for (let proofIndex = index - 1; proofIndex >= Math.max(0, index - 3); proofIndex -= 1) {
      const candidate = view.history[proofIndex];
      if (candidate.type === "claim_proven" && candidate.actor_id === playerId) {
        role = candidate.details.role;
        break;
      }
    }
    return {
      sequence: event.sequence,
      returnedRole: typeof role === "string" && role in ROLE_LABELS ? role as Role : null,
    };
  }
  return null;
}

function TravelingThreadGraphics({
  sourceAnchorId,
  targetAnchorId,
  labelElementId,
  stopAtTargetEdge,
  bend,
  kind,
  pulseTarget = true,
  animate = true,
  paused = false,
  duration = THREAD_DRAW_DURATION_MS,
}: {
  sourceAnchorId: string;
  targetAnchorId?: string;
  labelElementId?: string;
  stopAtTargetEdge?: boolean;
  bend: number;
  kind: "action" | "response";
  pulseTarget?: boolean;
  animate?: boolean;
  paused?: boolean;
  duration?: number;
}) {
  const shadowRef = useRef<SVGPathElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const arrowRef = useRef<SVGGElement>(null);
  const targetRef = useRef<SVGCircleElement>(null);
  const elapsedRef = useRef(0);
  const animationIdentityRef = useRef("");

  useLayoutEffect(() => {
    const line = lineRef.current;
    const shadow = shadowRef.current;
    const arrow = arrowRef.current;
    const target = targetRef.current;
    const label = labelElementId ? document.getElementById(labelElementId) : null;
    const sourceAnchor = document.getElementById(sourceAnchorId);
    const targetAnchor = targetAnchorId ? document.getElementById(targetAnchorId) : null;
    const svg = line?.ownerSVGElement;
    if (!line || !shadow || !arrow || !target || !sourceAnchor || !svg) return;
    const animationIdentity = `${sourceAnchorId}:${targetAnchorId ?? "center"}:${labelElementId ?? ""}`;
    if (animationIdentityRef.current !== animationIdentity) {
      animationIdentityRef.current = animationIdentity;
      elapsedRef.current = 0;
    }
    const svgBounds = svg.getBoundingClientRect();
    if (!svgBounds.width || !svgBounds.height) {
      line.style.opacity = "1";
      shadow.style.opacity = "1";
      arrow.style.opacity = "1";
      if (label) label.style.opacity = "1";
      return;
    }
    const toPoint = (bounds: DOMRect) => ({
      x: ((bounds.left + bounds.width / 2 - svgBounds.left) / svgBounds.width) * 100,
      y: ((bounds.top + bounds.height / 2 - svgBounds.top) / svgBounds.height) * 100,
    });
    const source = toPoint(sourceAnchor.getBoundingClientRect());
    let destination = targetAnchor
      ? toPoint(targetAnchor.getBoundingClientRect())
      : { x: 50, y: 49 };
    if (targetAnchor && stopAtTargetEdge) {
      const bounds = targetAnchor.getBoundingClientRect();
      const targetCenter = destination;
      const roughControl = {
        x: (source.x + targetCenter.x) / 2,
        y: (source.y + targetCenter.y) / 2 + bend,
      };
      const deltaX = roughControl.x - targetCenter.x;
      const deltaY = roughControl.y - targetCenter.y;
      const halfWidth = (bounds.width / svgBounds.width) * 50;
      const halfHeight = (bounds.height / svgBounds.height) * 50;
      const horizontal = Math.abs(deltaX) > 0.001 ? halfWidth / Math.abs(deltaX) : Infinity;
      const vertical = Math.abs(deltaY) > 0.001 ? halfHeight / Math.abs(deltaY) : Infinity;
      const scale = Math.min(horizontal, vertical);
      const magnitude = Math.hypot(deltaX, deltaY) || 1;
      const arrowClearance = 1.55;
      destination = {
        x: targetCenter.x + deltaX * scale + (deltaX / magnitude) * arrowClearance,
        y: targetCenter.y + deltaY * scale + (deltaY / magnitude) * arrowClearance,
      };
    }
    const middleX = (source.x + destination.x) / 2;
    const middleY = (source.y + destination.y) / 2 + bend;
    target.setAttribute("cx", String(destination.x));
    target.setAttribute("cy", String(destination.y));
    line.style.opacity = "1";
    shadow.style.opacity = "1";
    arrow.style.opacity = "1";
    const bounds = line.ownerSVGElement?.getBoundingClientRect();
    const xScale = (bounds?.width ?? 100) / 100;
    const yScale = (bounds?.height ?? 100) / 100;

    const drawTo = (progress: number) => {
      const firstControl = {
        x: source.x + (middleX - source.x) * progress,
        y: source.y + (middleY - source.y) * progress,
      };
      const secondControl = {
        x: middleX + (destination.x - middleX) * progress,
        y: middleY + (destination.y - middleY) * progress,
      };
      const point = {
        x: firstControl.x + (secondControl.x - firstControl.x) * progress,
        y: firstControl.y + (secondControl.y - firstControl.y) * progress,
      };
      const partialPath = `M ${source.x} ${source.y} Q ${firstControl.x} ${firstControl.y} ${point.x} ${point.y}`;
      line.setAttribute("d", partialPath);
      shadow.setAttribute("d", partialPath);
      const angle = Math.atan2(
        (point.y - firstControl.y) * yScale,
        (point.x - firstControl.x) * xScale,
      ) * 180 / Math.PI;
      arrow.setAttribute("transform", `translate(${point.x} ${point.y}) rotate(${angle})`);
      if (label) {
        const labelProgress = 0.52;
        const inverse = 1 - labelProgress;
        const labelPoint = {
          x: inverse ** 2 * source.x
            + 2 * inverse * labelProgress * firstControl.x
            + labelProgress ** 2 * point.x,
          y: inverse ** 2 * source.y
            + 2 * inverse * labelProgress * firstControl.y
            + labelProgress ** 2 * point.y,
        };
        label.style.left = `${labelPoint.x}%`;
        label.style.top = `${labelPoint.y}%`;
        label.style.opacity = progress > 0.16 ? "1" : "0";
      }
    };
    if (!animate) {
      elapsedRef.current = 1;
      drawTo(1);
      target.classList.add("thread-target--arrived");
      return;
    }

    drawTo(1 - (1 - elapsedRef.current) ** 3);
    if (paused) return;

    let frame = 0;
    const startedAt = performance.now();
    const startingElapsed = elapsedRef.current;
    const animateFrame = (now: number) => {
      const elapsed = Math.min(1, startingElapsed + (now - startedAt) / duration);
      elapsedRef.current = elapsed;
      const progress = 1 - (1 - elapsed) ** 3;
      drawTo(progress);
      if (elapsed < 1) {
        frame = window.requestAnimationFrame(animateFrame);
      } else {
        target.classList.add("thread-target--arrived");
      }
    };
    frame = window.requestAnimationFrame(animateFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [animate, bend, duration, labelElementId, paused, sourceAnchorId, stopAtTargetEdge, targetAnchorId]);

  return (
    <>
      <path ref={shadowRef} className={`${kind}-thread__shadow`} d="" />
      <path ref={lineRef} className={`${kind}-thread__flow`} d="" />
      <g ref={arrowRef} className={`${kind}-thread__moving-arrow`}>
        <path d="M -1.3 -1.15 L 1.6 0 L -1.3 1.15 L -0.45 0 z" />
      </g>
      <circle
        ref={targetRef}
        className={`${kind}-thread__target${pulseTarget ? "" : " thread-target--suppressed"}`}
        cx="0"
        cy="0"
        r="2.2"
      />
    </>
  );
}

function actionProvenance(option: LegalOption, cards: PrivateCard[]): ActionProvenance | null {
  const action = typeof option.data.action === "string" ? option.data.action : null;
  const optionRole = typeof option.data.role === "string" && option.data.role in ROLE_LABELS
    ? option.data.role as Role
    : null;
  if (!action && !optionRole) return null;
  const role = optionRole ?? (action ? ACTION_ROLES[action] : null);
  if (!role) {
    return {
      kind: "basic",
      role: null,
      explanation: "Basic action — no character claim is required.",
    };
  }
  if (cards.some((card) => card.role === role)) {
    return {
      kind: "card",
      role,
      explanation: `Card-backed claim — you hold the required ${ROLE_LABELS[role]}.`,
    };
  }
  return {
    kind: "bluff",
    role,
    explanation: `Bluff — you do not hold the ${ROLE_LABELS[role]} this action claims.`,
  };
}

function decisionOptionDescription(
  option: LegalOption,
  decisionKind: string,
  view: PublicGameView,
): string | null {
  const action = typeof option.data.action === "string" ? option.data.action : null;
  if (action) return ACTION_DESCRIPTIONS[action] ?? null;

  const passes = option.id.endsWith(":pass") || option.label.toLowerCase().includes("pass");
  if (decisionKind === "action_challenge") {
    const role = view.pending_action?.claimed_role;
    const roleName = role ? ROLE_LABELS[role] : "character";
    return passes
      ? `Accept the ${roleName} claim. If every opponent passes, the action proceeds.`
      : `Challenge the ${roleName} claim. A false claimant loses influence and the action fails; if the claim is proven, you lose influence instead.`;
  }
  if (decisionKind === "block_challenge") {
    const role = view.pending_block?.claimed_role;
    const roleName = role ? ROLE_LABELS[role] : "character";
    return passes
      ? `Accept the ${roleName} block. If every opponent passes, the original action is stopped.`
      : `Challenge the ${roleName} block. A false blocker loses influence and the action continues; if the block is proven, you lose influence instead.`;
  }
  if (decisionKind === "block") {
    const role = typeof option.data.role === "string" && option.data.role in ROLE_LABELS
      ? option.data.role as Role
      : null;
    return role
      ? `Claim ${ROLE_LABELS[role]} to block the pending action. Your claim may be challenged.`
      : "Do not block. The pending action continues unless another eligible player can respond.";
  }
  if (decisionKind === "claim_response") {
    return option.id.includes("prove")
      ? "Reveal the claimed character to prove your claim. The challenger loses influence; your revealed card is shuffled back and replaced."
      : "Concede that you cannot prove the claim. You lose influence, and your claimed action or block fails.";
  }
  if (decisionKind === "lose_influence") {
    return "Reveal this card permanently and lose it as influence. You are eliminated if no hidden influence remains.";
  }
  if (decisionKind === "setup_card") {
    return "Keep this character as your privately known starting influence. The other four choices are set aside face down.";
  }
  if (decisionKind === "exchange") {
    return "Keep this set of cards. Every other card drawn for the Exchange returns to the Court deck.";
  }
  return null;
}

function statusCopy(match: MatchPayload, spectatorPaused = false): string {
  const view = gameView(match);
  if (match.status === "finished") {
    const winner = view.players.find((player) => player.id === view.winner_id);
    return `${winner ? playerLabel(winner) : "The victor"} controls the court`;
  }
  if (match.status === "agent_error") return "The court has fallen silent";
  if (match.status === "waiting_for_human") return "Your counsel is required";
  if (match.mode === "ai_only" && spectatorPaused) return "The court is paused";
  if (match.mode === "ai_only" && match.status === "paused") return "The court deliberates";
  if (match.status === "paused") return "The court is paused";
  return "The court deliberates";
}

function optionRoles(option: LegalOption): Role[] {
  const role = option.data.role;
  if (typeof role === "string" && role in ROLE_LABELS) return [role as Role];
  const roles = option.data.roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter(
    (candidate): candidate is Role =>
      typeof candidate === "string" && candidate in ROLE_LABELS,
  );
}

function SetupPanel({
  openaiConfigured,
  replacing,
  busy,
  onStart,
  onConfigureKey,
  onClose,
}: {
  openaiConfigured: boolean;
  replacing: boolean;
  busy: boolean;
  onStart: (players: number, mode: MatchMode) => Promise<void>;
  onConfigureKey: () => void;
  onClose?: () => void;
}) {
  const [players, setPlayers] = useState(3);
  const [mode, setMode] = useState<MatchMode>("human_vs_ai");

  return (
    <section className={replacing ? "setup-panel setup-panel--modal" : "setup-panel"}>
      {onClose && (
        <button className="icon-button setup-panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      )}
      <p className="eyebrow">Convene the court</p>
      <h1>{replacing ? "Begin a new intrigue" : "Trust no one."}</h1>
      <p className="setup-panel__intro">
        Bluff, challenge, and scheme your way to power against an assembly of language models.
      </p>

      <fieldset className="choice-field">
        <legend>Mode of play</legend>
        <div className="segmented segmented--large">
          <button
            className={mode === "human_vs_ai" ? "selected" : ""}
            onClick={() => setMode("human_vs_ai")}
          >
            <span>Take a seat</span>
            <small>You against the court</small>
          </button>
          <button
            className={mode === "ai_only" ? "selected" : ""}
            onClick={() => setMode("ai_only")}
          >
            <span>Observe</span>
            <small>Watch agents scheme</small>
          </button>
        </div>
      </fieldset>

      <fieldset className="choice-field">
        <legend>Seats at the table</legend>
        <div className="seat-picker">
          {[2, 3, 4, 5, 6].map((count) => (
            <button
              key={count}
              className={players === count ? "selected" : ""}
              onClick={() => setPlayers(count)}
              aria-label={`${count} players`}
            >
              {count}
            </button>
          ))}
        </div>
        {players === 2 && <small className="field-note">Uses the published two-player setup.</small>}
      </fieldset>

      {!openaiConfigured && (
        <div className="notice notice--warning">
          <span className="notice__mark">!</span>
          <span>
            No OpenAI key is configured. You can create the table, but the first agent decision
            will stop until one is added.
            <button className="notice__action" onClick={onConfigureKey}>Add an API key</button>
          </span>
        </div>
      )}

      <button
        className="primary-button primary-button--large"
        disabled={busy}
        onClick={() => void onStart(players, mode)}
      >
        {busy ? "Gathering the court…" : "Enter the court"}
      </button>
    </section>
  );
}

function Landing({
  health,
  busy,
  onStart,
  onConfigureKey,
}: {
  health: HealthPayload | null;
  busy: boolean;
  onStart: (players: number, mode: MatchMode) => Promise<void>;
  onConfigureKey: () => void;
}) {
  return (
    <main className="landing">
      <div className="landing__art" aria-hidden="true" />
      <div className="landing__shade" />
      <header className="landing__header">
        <div className="brand-mark">E</div>
        <div className="brand-copy">
          <strong>EvoCoup</strong>
          <span>An experiment in artificial intrigue</span>
        </div>
      </header>
      <div className="landing__setup">
        <SetupPanel
          openaiConfigured={health?.openai_configured ?? false}
          replacing={false}
          busy={busy}
          onStart={onStart}
          onConfigureKey={onConfigureKey}
        />
      </div>
      <footer className="landing__footer">
        <span>Faithful base rules</span>
        <i />
        <span>Two to six players</span>
        <i />
        <span>Local and private</span>
      </footer>
    </main>
  );
}

function InfluenceStack({ player, revealedRoles }: { player: PlayerView; revealedRoles: Role[] }) {
  return (
    <div
      className="influence-stack"
      aria-label={`${player.hidden_influence_count} hidden influence`}
    >
      <div id={`influence-stack-${player.id}`} className="influence-stack__hidden">
        {Array.from({ length: player.hidden_influence_count }, (_, index) => (
          <img key={`hidden-${index}`} src="/images/cards/card_back.png" alt="Hidden influence" />
        ))}
      </div>
      {revealedRoles.length > 0 && (
        <div
          className="revealed-influence-row"
          aria-label={`${revealedRoles.length} revealed influence`}
        >
          {revealedRoles.map((role, index) => (
            <div
              className="revealed-card"
              key={`${role}-${index}`}
              title={`${ROLE_LABELS[role]} — ${ROLE_RULES[role]}`}
              tabIndex={0}
            >
              <img src={roleImage(role)} alt={`Revealed ${ROLE_LABELS[role]}`} />
              <span>×</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingIndicator({
  label,
  player,
  afterFailedChallenge,
}: {
  label: string | null;
  player: PlayerView;
  afterFailedChallenge: boolean;
}) {
  const [renderedLabel, setRenderedLabel] = useState(label);
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setRenderedLabel(label),
      label ? 0 : 220,
    );
    return () => window.clearTimeout(timeout);
  }, [label]);
  if (!player.is_alive) return null;
  return (
    <div
      className={`thinking-indicator${
        afterFailedChallenge && renderedLabel === "choosing a card to reveal…"
          ? " thinking-indicator--after-failed-challenge"
          : ""
      }${label ? " thinking-indicator--visible" : ""}`}
      aria-label={label ? `${playerLabel(player)}: ${renderedLabel}` : undefined}
      aria-hidden={!label}
    >
      <span /><span /><span />
      <small>{renderedLabel ?? ""}</small>
    </div>
  );
}

function PlayerSeat({
  player,
  count,
  active,
  human,
  revealedRoles,
  winning,
  thinkingLabel,
  pendingAction,
  actionTarget,
  actionEntering,
  actionSubdued,
  actionConcluding,
  actionConcludingDelayed,
  blockingRole,
  blockEntering,
  blockSubdued,
  blockConcluding,
  challenging,
  outcome,
  outcomeDelayed,
}: {
  player: PlayerView;
  count: number;
  active: boolean;
  human: boolean;
  revealedRoles: Role[];
  winning: boolean;
  thinkingLabel: string | null;
  pendingAction: PublicGameView["pending_action"];
  actionTarget: PlayerView | null;
  actionEntering: boolean;
  actionSubdued: boolean;
  actionConcluding: boolean;
  actionConcludingDelayed: boolean;
  blockingRole: Role | null;
  blockEntering: boolean;
  blockSubdued: boolean;
  blockConcluding: boolean;
  challenging: boolean;
  outcome: "positive" | "negative" | null;
  outcomeDelayed: boolean;
}) {
  const { x, y } = seatPosition(player, count);
  const inward = inwardOffset(x, y);
  const style = {
    "--seat-x": `${x}%`,
    "--seat-y": `${y}%`,
    "--inward-x": `${inward.x}px`,
    "--inward-y": `${inward.y}px`,
  } as CSSProperties;
  return (
    <article
      id={`seat-anchor-${player.id}`}
      className={`player-seat${active ? " player-seat--active" : ""}${
        player.is_alive ? "" : " player-seat--fallen"
      }${human ? " player-seat--human" : ""}${
        challenging ? " player-seat--challenging" : ""
      }${winning ? " player-seat--winner" : ""
      }`}
      style={style}
      aria-label={`${human ? "You" : player.name}: ${player.coins} coins, ${player.hidden_influence_count} hidden influence`}
    >
      <div className="player-seat__sigil">
        {human ? "You" : String(player.seat + 1).padStart(2, "0")}
      </div>
      <div className="player-seat__body">
        <div className="player-seat__resources">
          <span className="coin" aria-hidden="true">◆</span>
          <b>{player.coins}</b>
          <span className="resource-label">coin{player.coins === 1 ? "" : "s"}</span>
        </div>
        <InfluenceStack player={player} revealedRoles={revealedRoles} />
      </div>
      <ThinkingIndicator
        label={thinkingLabel}
        player={player}
        afterFailedChallenge={outcome === "negative"}
      />
      {pendingAction && (
        <div
          className={`seat-action-claim${
            actionEntering ? " seat-action-claim--entering" : ""
          }${
            actionSubdued ? " seat-action-claim--subdued" : ""
          }${actionConcluding ? " seat-action-claim--concluding" : ""}${
            actionConcludingDelayed ? " action-concluding--delayed" : ""
          }`}
          aria-label={`${playerLabel(player)} claims ${pendingAction.claimed_role ? ROLE_LABELS[pendingAction.claimed_role] : titleCase(pendingAction.action)} for ${titleCase(pendingAction.action)}${actionTarget ? ` against ${playerLabel(actionTarget)}` : ""}`}
          title={`${titleCase(pendingAction.action)}${actionTarget ? ` against ${playerLabel(actionTarget)}` : ""}. ${pendingAction.claimed_role ? `Claimed ${ROLE_LABELS[pendingAction.claimed_role]}; this may be a bluff.` : ACTION_DESCRIPTIONS[pendingAction.action] ?? ""}`}
          tabIndex={0}
        >
          {pendingAction.claimed_role ? (
            <img
              id={`action-card-anchor-${player.id}`}
              src={roleImage(pendingAction.claimed_role)}
              alt=""
            />
          ) : (
            <b id={`action-card-anchor-${player.id}`}>
              {ACTION_MARKS[pendingAction.action] ?? "◇"}
            </b>
          )}
          {pendingAction.claimed_role && <small>claim</small>}
          {pendingAction.claimed_role && (
            <div className="board-role-tooltip" role="tooltip">
              <strong>{ROLE_LABELS[pendingAction.claimed_role]} · Claimed</strong>
              <span>{ROLE_RULES[pendingAction.claimed_role]}</span>
              <em>This card represents a claim and may be a bluff.</em>
            </div>
          )}
        </div>
      )}
      {blockingRole && (
        <div
          className={`seat-response-indicator seat-response-indicator--blocking${
            blockEntering ? " seat-response-indicator--entering" : ""
          }${blockSubdued ? " seat-response-indicator--subdued" : ""}${
            blockConcluding ? " seat-response-indicator--concluding" : ""
          }`}
          aria-label={`${playerLabel(player)} is blocking as ${ROLE_LABELS[blockingRole]}`}
          tabIndex={0}
        >
          <img
            id={`block-card-anchor-${player.id}`}
            src={roleImage(blockingRole)}
            alt=""
          />
          <div className="board-role-tooltip board-role-tooltip--response" role="tooltip">
            <strong>{ROLE_LABELS[blockingRole]} · Claimed block</strong>
            <span>{ROLE_RULES[blockingRole]}</span>
            <em>This card represents a claim and may be a bluff.</em>
          </div>
        </div>
      )}
      {outcome && (
        <div
          className={`player-outcome-stamp player-outcome-stamp--${outcome}${
            outcomeDelayed ? " player-outcome-stamp--delayed" : ""
          }`}
          aria-label={`${outcome === "positive" ? "Positive" : "Negative"} action outcome for ${playerLabel(player)}`}
        >
          {outcome === "positive" ? "✓" : "×"}
        </div>
      )}
      {!player.is_alive && <span className="fallen-ribbon">eliminated</span>}
    </article>
  );
}

function ActionThread({
  action,
  view,
  canceled,
  succeeded,
  pulseTarget,
  animate,
  subdued = false,
  concluding = false,
  concludingDelayed = false,
  paused = false,
}: {
  action: NonNullable<PublicGameView["pending_action"]>;
  view: PublicGameView;
  canceled: boolean;
  succeeded: boolean;
  pulseTarget: boolean;
  animate: boolean;
  subdued?: boolean;
  concluding?: boolean;
  concludingDelayed?: boolean;
  paused?: boolean;
}) {
  const actor = view.players.find((player) => player.id === action.actor_id);
  const target = action.target_id
    ? view.players.find((player) => player.id === action.target_id)
    : null;
  if (!actor) return null;
  const destinationLabel = target ? playerLabel(target) : "the center of the table";
  const lineLabelId = `action-line-label-${actor.id}`;
  return (
    <>
      <svg
        className={`action-thread${
          animate ? "" : " action-thread--resumed"
        }${subdued ? " action-thread--subdued" : ""}${
          concluding ? " action-thread--concluding" : ""
        }${concludingDelayed ? " action-concluding--delayed" : ""}`}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${titleCase(action.action)} from ${playerLabel(actor)} to ${destinationLabel}${canceled ? ", canceled" : succeeded ? ", succeeded" : ""}`}
      >
        <TravelingThreadGraphics
          sourceAnchorId={action.claimed_role
            ? `action-card-anchor-${actor.id}`
            : `seat-anchor-${actor.id}`}
          targetAnchorId={target ? `seat-anchor-${target.id}` : undefined}
          labelElementId={lineLabelId}
          stopAtTargetEdge={Boolean(target)}
          bend={-7}
          kind="action"
          pulseTarget={pulseTarget}
          animate={animate}
          paused={paused}
        />
      </svg>
      <span
        id={lineLabelId}
        className={`action-thread__label${
          subdued ? " action-thread__label--subdued" : ""
        }${concluding ? " action-thread__label--concluding" : ""}${
          concludingDelayed ? " action-concluding--delayed" : ""
        }`}
        aria-hidden="true"
      >
        {titleCase(action.action)}
      </span>
    </>
  );
}

function ResponseThread({
  from,
  to,
  view,
  kind,
  targetKind,
  pulseTarget = true,
  animate = true,
  subdued = false,
  concluding = false,
  paused = false,
}: {
  from: string;
  to: string;
  view: PublicGameView;
  kind: "block" | "challenge";
  targetKind: "action" | "block";
  pulseTarget?: boolean;
  animate?: boolean;
  subdued?: boolean;
  concluding?: boolean;
  paused?: boolean;
}) {
  const sourcePlayer = view.players.find((player) => player.id === from);
  const targetPlayer = view.players.find((player) => player.id === to);
  if (!sourcePlayer || !targetPlayer) return null;
  const lineLabel = kind === "block" ? "Blocking" : "Challenge";
  const lineLabelId = `response-line-label-${kind}-${from}`;
  return (
    <>
      <svg
        className={`response-thread response-thread--${kind}${animate ? "" : " response-thread--resumed"}${
          subdued ? " response-thread--subdued" : ""
        }${concluding ? " response-thread--concluding" : ""}`}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${lineLabel} from ${playerLabel(sourcePlayer)} to ${playerLabel(targetPlayer)}`}
      >
        <TravelingThreadGraphics
          sourceAnchorId={kind === "block"
            ? `block-card-anchor-${from}`
            : `seat-anchor-${from}`}
          targetAnchorId={`${targetKind}-card-anchor-${to}`}
          labelElementId={lineLabelId}
          stopAtTargetEdge
          bend={7}
          kind="response"
          pulseTarget={pulseTarget}
          animate={animate}
          paused={paused}
        />
      </svg>
      <span
        id={lineLabelId}
        className={`response-thread__label response-thread__label--${kind}${
          subdued ? " response-thread__label--subdued" : ""}${
          concluding ? " response-thread__label--concluding" : ""
        }`}
        aria-hidden="true"
      >
        {lineLabel}
      </span>
    </>
  );
}

function CourtStatus({ view }: { view: PublicGameView }) {
  const action = view.pending_action;
  const actor = action ? view.players.find((player) => player.id === action.actor_id) : null;
  const target = action?.target_id
    ? view.players.find((player) => player.id === action.target_id)
    : null;
  return (
    <section className="court-status" aria-label="Current turn and table resources">
      <div className="deck-stack" title={`${view.court_deck_count} cards in the Court deck`}>
        <span className="deck-stack__shadow" />
        <img src="/images/cards/card_back.png" alt="Court deck" />
        <b>{view.court_deck_count}</b>
      </div>
      <div className="table-center__copy">
        <small>Turn {view.turn}</small>
        {action ? (
          <>
            <strong>{titleCase(action.action)}</strong>
            <span>
              {actor ? playerLabel(actor) : ""}
              {target ? ` against ${playerLabel(target)}` : ""}
            </span>
          </>
        ) : (
          <>
            <strong>{titleCase(view.phase)}</strong>
            <span>The next move is being weighed</span>
          </>
        )}
      </div>
      <div className="treasury" title={`${view.treasury} coins remain in the treasury`}>
        <span className="coin coin--large">◆</span>
        <b>{view.treasury}</b>
      </div>
    </section>
  );
}

function TablePieces({ view }: { view: PublicGameView }) {
  return (
    <div className="table-pieces" aria-label={`${view.court_deck_count} cards and ${view.treasury} coins remain`}>
      <div
        id="court-deck-anchor"
        className="table-pieces__deck"
        aria-label={`${view.court_deck_count} cards in the Court deck`}
      >
        {Array.from({ length: view.court_deck_count }, (_, index) => (
          <img
            key={`deck-${index}`}
            src="/images/cards/card_back.png"
            alt=""
            style={{
              "--card-x": `${(scatteredValue(index, 1) - 0.5) * 22}px`,
              "--card-y": `${(scatteredValue(index, 2) - 0.5) * 15}px`,
              "--card-rotation": `${(scatteredValue(index, 3) - 0.5) * 18}deg`,
            } as CSSProperties}
          />
        ))}
      </div>
      <div className="table-pieces__coins" aria-label={`${view.treasury} coins in the treasury`}>
        {Array.from({ length: view.treasury }, (_, index) => (
          <span
            key={`coin-${index}`}
            aria-hidden="true"
            style={{
              "--coin-x": `${27.5 + scatteredValue(index, 4) * 45}%`,
              "--coin-y": `${28 + scatteredValue(index, 5) * 44}%`,
              "--coin-rotation": `${scatteredValue(index, 6) * 180}deg`,
              "--coin-scale": `${0.78 + scatteredValue(index, 7) * 0.42}`,
            } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

function InfluenceReveal({
  reveal,
  view,
}: {
  reveal: NonNullable<CourtResult["reveal"]>;
  view: PublicGameView;
}) {
  const player = view.players.find((candidate) => candidate.id === reveal.playerId);
  if (!player) return null;
  const { x, y } = seatPosition(player, view.players.length);
  const inward = inwardOffset(x, y);
  const style = {
    "--reveal-x": `${x}%`,
    "--reveal-y": `${y}%`,
    "--reveal-inward-x": `${inward.x * 1.7}px`,
    "--reveal-inward-y": `${inward.y * 1.7}px`,
  } as CSSProperties;
  return (
    <div
      className="influence-reveal"
      style={style}
      role="img"
      aria-label={`${playerLabel(player)} reveals ${ROLE_LABELS[reveal.role]}`}
    >
      <div className="influence-reveal__card">
        <img
          className="influence-reveal__face influence-reveal__face--back"
          src="/images/cards/card_back.png"
          alt=""
        />
        <img
          className="influence-reveal__face influence-reveal__face--front"
          src={roleImage(reveal.role)}
          alt=""
        />
      </div>
    </div>
  );
}

type CardTransferGeometry = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  scale: number;
  width: number;
  height: number;
};

function useCardTransferGeometry(
  sourceId: string,
  targetId: string,
): CardTransferGeometry | null {
  const [geometry, setGeometry] = useState<CardTransferGeometry | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const source = document.getElementById(sourceId);
      const target = document.getElementById(targetId);
      if (!source || !target) return;
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const x = sourceRect.left + sourceRect.width / 2;
      const y = sourceRect.top + sourceRect.height / 2;
      setGeometry({
        x,
        y,
        dx: targetRect.left + targetRect.width / 2 - x,
        dy: targetRect.top + targetRect.height / 2 - y,
        scale: Math.max(0.2, Math.min(2.2, targetRect.height / Math.max(1, sourceRect.height))),
        width: sourceRect.width || 52,
        height: sourceRect.height || 78,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [sourceId, targetId]);
  return geometry;
}

function ReplacementDraw({
  playerId,
  playerName,
  humanCard,
}: {
  playerId: string;
  playerName: string;
  humanCard: PrivateCard | null;
}) {
  const targetId = humanCard ? `hand-card-${humanCard.id}` : `influence-stack-${playerId}`;
  const geometry = useCardTransferGeometry("court-deck-anchor", targetId);

  if (!geometry) return null;
  const style = {
    "--replacement-start-x": `${geometry.x}px`,
    "--replacement-start-y": `${geometry.y}px`,
    "--replacement-dx": `${geometry.dx}px`,
    "--replacement-dy": `${geometry.dy}px`,
    "--replacement-scale": geometry.scale,
    "--replacement-width": `${geometry.width}px`,
    "--replacement-height": `${geometry.height}px`,
    "--replacement-duration": `${RESULT_DURATION_MS}ms`,
  } as CSSProperties;
  return (
    <div
      className={`replacement-draw${humanCard ? " replacement-draw--human" : ""}`}
      style={style}
      role="img"
      aria-label={`Replacement card drawn from the Court deck to ${playerName}`}
    >
      <div className="replacement-draw__card">
        <img
          className="replacement-draw__face replacement-draw__face--back"
          src="/images/cards/card_back.png"
          alt=""
        />
        {humanCard && (
          <img
            className="replacement-draw__face replacement-draw__face--front"
            src={roleImage(humanCard.role)}
            alt=""
          />
        )}
      </div>
    </div>
  );
}

function ProofReturn({
  proof,
  playerName,
}: {
  proof: NonNullable<CourtResult["proofReturn"]>;
  playerName: string;
}) {
  const sourceId = `${proof.claimKind}-card-anchor-${proof.playerId}`;
  const geometry = useCardTransferGeometry(sourceId, "court-deck-anchor");
  if (!geometry) return null;
  const style = {
    "--proof-start-x": `${geometry.x}px`,
    "--proof-start-y": `${geometry.y}px`,
    "--proof-dx": `${geometry.dx}px`,
    "--proof-dy": `${geometry.dy}px`,
    "--proof-scale": geometry.scale,
    "--proof-final-scale": geometry.scale * 0.86,
    "--proof-width": `${geometry.width}px`,
    "--proof-height": `${geometry.height}px`,
    "--proof-duration": `${RESULT_DURATION_MS}ms`,
  } as CSSProperties;
  return (
    <div
      className="proof-return"
      style={style}
      role="img"
      aria-label={`${ROLE_LABELS[proof.role]} returned from ${playerName} to the Court deck`}
    >
      <img src={roleImage(proof.role)} alt="" />
    </div>
  );
}

function CourtResultBanner({
  result,
  delayed,
}: {
  result: CourtResult;
  delayed: boolean;
}) {
  return (
    <div
      key={result.sequence}
      className={`court-result court-result--${result.kind}${delayed ? " court-result--delayed" : ""}`}
      role="status"
      aria-label={`Action result: ${result.label}`}
    >
      {result.label}
    </div>
  );
}

function usePausableTimeout(
  callback: () => void,
  duration: number,
  paused: boolean,
  timerKey: string | number | null,
): void {
  const callbackRef = useRef(callback);
  const timerStateRef = useRef({
    key: null as string | number | null,
    remaining: 0,
  });

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const timerState = timerStateRef.current;
    if (timerState.key !== timerKey) {
      timerState.key = timerKey;
      timerState.remaining = duration;
    }
    if (timerKey === null || paused) return;

    const startedAt = Date.now();
    const timeout = window.setTimeout(() => {
      timerState.remaining = 0;
      callbackRef.current();
    }, timerState.remaining);
    return () => {
      window.clearTimeout(timeout);
      if (timerState.key === timerKey && timerState.remaining > 0) {
        timerState.remaining = Math.max(0, timerState.remaining - (Date.now() - startedAt));
      }
    };
  }, [duration, paused, timerKey]);
}

function useCourtResultSequence(
  view: PublicGameView,
  delayActions: boolean,
  paused: boolean,
): CourtResult | null {
  const results = courtResultsForLatestAction(view);
  const allResults = courtResultsForHistory(view);
  const actionDeclarations = view.history.filter((event) => event.type === "action_declared");
  const recentResultBoundary = actionDeclarations.at(-2)?.sequence ?? 0;
  const initialResults = allResults
    .filter((result) => result.sequence > recentResultBoundary)
    .map((result) => ({
      ...result,
      delayed: delayActions && result.kind === "action",
  }));
  const [active, setActive] = useState<CourtResult | null>(() => initialResults[0] ?? null);
  const queued = useRef<CourtResult[]>(initialResults.slice(1));
  const [seenSequences, setSeenSequences] = useState(
    () => new Set(allResults.map((result) => result.sequence)),
  );
  const latestSequence = view.history.at(-1)?.sequence ?? 0;
  const previousLatest = useRef(latestSequence);
  const unseenResults = allResults.filter((result) => !seenSequences.has(result.sequence));
  const immediateResult = !active && unseenResults.length > 0
    ? {
        ...unseenResults[0],
        delayed: delayActions && unseenResults[0].kind === "action",
      }
    : null;

  useEffect(() => {
    if (latestSequence < previousLatest.current) {
      const resetResults = results.map((result) => ({
        ...result,
        delayed: delayActions && result.kind === "action",
      }));
      setSeenSequences(new Set(allResults.map((result) => result.sequence)));
      queued.current = resetResults.slice(1);
      setActive(resetResults[0] ?? null);
      previousLatest.current = latestSequence;
      return;
    }
    previousLatest.current = latestSequence;
    if (unseenResults.length === 0) return;
    const promotion = window.setTimeout(() => {
      setSeenSequences((current) => {
        const next = new Set(current);
        for (const result of unseenResults) next.add(result.sequence);
        return next;
      });
      for (const result of unseenResults) {
        queued.current.push({
          ...result,
          delayed: delayActions && result.kind === "action",
        });
      }
      if (!active && queued.current.length > 0) {
        setActive(queued.current.shift() ?? null);
      }
    }, 0);
    return () => window.clearTimeout(promotion);
  }, [active, allResults, delayActions, latestSequence, results, unseenResults]);

  usePausableTimeout(
    () => setActive(queued.current.shift() ?? null),
    active ? RESULT_DURATION_MS + (active.delayed ? RESULT_ENTRY_DELAY_MS : 0) : 0,
    paused,
    active?.sequence ?? null,
  );

  return active ?? immediateResult;
}

type PresentationTimeline = {
  result: CourtResult | null;
  resultActive: boolean;
  action: NonNullable<PublicGameView["pending_action"]> | null;
  block: PublicGameView["pending_block"];
  challenge: InteractionState["challenge"];
  actionSequence: number;
  actionVisible: boolean;
  actionAnimate: boolean;
  actionSubdued: boolean;
  actionConcluding: boolean;
  actionDelayed: boolean;
  actionCanceled: boolean;
  actionSucceeded: boolean;
  blockAnimate: boolean;
  blockSubdued: boolean;
  blockConcluding: boolean;
  challengeConcluding: boolean;
  activePlayerId: string;
  outcomes: Map<string, "positive" | "negative">;
};

function usePresentationTimeline(view: PublicGameView, paused: boolean): PresentationTimeline {
  const interaction = interactionState(view);
  const animateUnseenAction = interaction.status !== "pending" && !interaction.actionProgressed;
  const result = useCourtResultSequence(view, animateUnseenAction, paused);
  const presentedInteraction = result
    ? interactionState(view, result.actionSequence)
    : interaction;
  const resultActive = result !== null;
  const action = result?.action ?? interaction.action;
  const block = resultActive ? result.block : interaction.block;
  const challenge = resultActive ? result.challenge : interaction.challenge;
  const actionCanceled = presentedInteraction.status === "canceled";
  const actionSucceeded = presentedInteraction.status === "succeeded";
  const finalPresentedResultSequence = result
    ? courtResultsForHistory(view)
        .filter((candidate) => candidate.actionSequence === result.actionSequence)
        .at(-1)?.sequence ?? null
    : null;
  const actionConcluding = result !== null
    && (
      (presentedInteraction.concludingSequence !== null
        && result.sequence >= presentedInteraction.concludingSequence)
      || (view.winner_id !== null && result.kind === "death")
      || (presentedInteraction.status === "ended"
        && result.sequence === finalPresentedResultSequence)
    );
  return {
    result,
    resultActive,
    action,
    block,
    challenge,
    actionSequence: result?.actionSequence ?? interaction.actionSequence,
    actionVisible: action !== null
      && result?.kind !== "winner"
      && (resultActive || interaction.status === "pending"),
    actionAnimate: resultActive ? Boolean(result.delayed) : !interaction.actionProgressed,
    actionSubdued: Boolean(block || challenge),
    actionConcluding,
    actionDelayed: Boolean(result?.delayed),
    actionCanceled,
    actionSucceeded: resultActive ? result.kind === "action" : actionSucceeded,
    blockAnimate: !resultActive && !interaction.blockProgressed,
    blockSubdued: Boolean(challenge),
    blockConcluding: Boolean(block) && (Boolean(result?.blockConcluding) || actionConcluding),
    challengeConcluding: Boolean(challenge) && (Boolean(result?.challenge) || actionConcluding),
    activePlayerId: result?.actorId ?? view.active_player_id,
    outcomes: playerOutcomesForEvent(view, result?.sequence ?? null),
  };
}

function latestEventSequence(
  view: PublicGameView,
  predicate: (event: GameEvent) => boolean,
): number {
  return [...view.history].reverse().find(predicate)?.sequence ?? 0;
}

function usePresentationGate(key: string | null, duration: number, paused: boolean): boolean {
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  usePausableTimeout(() => setCompletedKey(key), duration, paused, key);

  return key === null || completedKey === key;
}

function PrivateHand({
  cards,
  revealedRoles,
  choosingInitialInfluence,
  highlightedRole,
  fallen,
  replacement,
}: {
  cards: PrivateCard[];
  revealedRoles: Role[];
  choosingInitialInfluence: boolean;
  highlightedRole: Role | null;
  fallen: boolean;
  replacement: { sequence: number; returnedRole: Role | null } | null;
}) {
  const guidance = cards.length > 0
    ? "Only you can see hidden cards"
    : choosingInitialInfluence
      ? "Choose your first influence in the right column"
      : "You have been eliminated";
  return (
    <section
      className={`private-hand${fallen ? " private-hand--fallen" : ""}${
        replacement ? " private-hand--replacement" : ""
      }`}
    >
      {replacement && (
        <div key={replacement.sequence} className="replacement-notice" role="status">
          <b>↻</b>
          <span>
            <strong>
              {replacement.returnedRole
                ? `${ROLE_LABELS[replacement.returnedRole]} returned`
                : "Proven card returned"}
            </strong>
            <small>Replacement drawn—even if it is the same character.</small>
          </span>
        </div>
      )}
      <div className="section-heading">
        <span>Your influence</span>
        <small>{guidance}</small>
      </div>
      <div className="private-hand__cards">
        {cards.map((card) => (
          <figure
            key={card.id}
            id={`hand-card-${card.id}`}
            className={`role-card${card.role === highlightedRole ? " role-card--highlighted" : ""}`}
            tabIndex={0}
          >
            <img src={roleImage(card.role)} alt={ROLE_LABELS[card.role]} />
            <figcaption>{ROLE_LABELS[card.role]}</figcaption>
            <div className="role-card__tooltip" role="tooltip">
              <strong>{ROLE_LABELS[card.role]}</strong>
              <span>{ROLE_RULES[card.role]}</span>
            </div>
          </figure>
        ))}
        {revealedRoles.map((role, index) => (
          <figure
            key={`revealed-${role}-${index}`}
            className="role-card role-card--revealed"
            tabIndex={0}
          >
            <img src={roleImage(role)} alt={`Revealed ${ROLE_LABELS[role]}`} />
            <figcaption>{ROLE_LABELS[role]}</figcaption>
            <span className="role-card__lost" aria-hidden="true">×</span>
            <div className="role-card__tooltip" role="tooltip">
              <strong>{ROLE_LABELS[role]} · Revealed</strong>
              <span>{ROLE_RULES[role]}</span>
            </div>
          </figure>
        ))}
      </div>
    </section>
  );
}

function DecisionOption({ option, decisionKind, view, cards, onChoose, onHighlightRole, disabled }: {
  option: LegalOption;
  decisionKind: string;
  view: PublicGameView;
  cards: PrivateCard[];
  onChoose: (id: string) => void;
  onHighlightRole: (role: Role | null) => void;
  disabled: boolean;
}) {
  const roles = optionRoles(option);
  const action = typeof option.data.action === "string" ? option.data.action : null;
  const provenance = actionProvenance(option, cards);
  const description = decisionOptionDescription(option, decisionKind, view);
  return (
    <button
      className="decision-option"
      disabled={disabled}
      title={description ?? undefined}
      onClick={() => onChoose(option.id)}
      onMouseEnter={() => onHighlightRole(provenance?.kind === "card" ? provenance.role : null)}
      onMouseLeave={() => onHighlightRole(null)}
      onFocus={() => onHighlightRole(provenance?.kind === "card" ? provenance.role : null)}
      onBlur={() => onHighlightRole(null)}
    >
      {roles.length > 0 ? (
        <span
          className={`decision-option__cards${provenance ? ` decision-option__cards--${provenance.kind}` : ""}`}
          aria-label={provenance?.explanation}
          title={provenance?.explanation ?? roles.map((role) => `${ROLE_LABELS[role]} — ${ROLE_RULES[role]}`).join("\n")}
        >
          {roles.map((role, index) => (
            <img key={`${role}-${index}`} src={roleImage(role)} alt="" />
          ))}
        </span>
      ) : (
        <span className="decision-option__mark">{action ? ACTION_MARKS[action] ?? "◇" : "◇"}</span>
      )}
      <span className="decision-option__copy">
        <span className="decision-option__label">{displayGameText(option.label, view)}</span>
        {description && <span className="decision-option__description">{description}</span>}
      </span>
      <span className="decision-option__meta">
        {roles.length === 0 && provenance?.role && (
          <span
            className={`action-provenance action-provenance--${provenance.kind}`}
            aria-label={provenance.explanation}
            title={provenance.explanation}
          >
            <img src={roleImage(provenance.role)} alt="" />
          </span>
        )}
        <span className="decision-option__arrow">→</span>
      </span>
    </button>
  );
}

function DecisionPanel({
  decision,
  view,
  cards,
  busy,
  onChoose,
  onHighlightRole,
}: {
  decision: DecisionRequest;
  view: PublicGameView;
  cards: PrivateCard[];
  busy: boolean;
  onChoose: (id: string) => void;
  onHighlightRole: (role: Role | null) => void;
}) {
  const claimedRole =
    decision.kind === "action_challenge"
      ? view.pending_action?.claimed_role
      : decision.kind === "block_challenge"
        ? view.pending_block?.claimed_role
        : null;
  const decisionPrompt = decision.kind === "block"
    ? blockDecisionPrompt(view) ?? displayGameText(decision.prompt, view)
    : decision.kind === "lose_influence"
      ? "Choose an influence to reveal."
    : displayGameText(decision.prompt, view);
  const lossReason = decision.kind === "lose_influence"
    ? influenceLossReason(decision.prompt, view)
    : null;

  return (
    <section className="decision-panel">
      <div className="decision-panel__heading">
        <span className="eyebrow">Your decision · {titleCase(decision.kind)}</span>
        {lossReason && <p className="decision-consequence">{lossReason}.</p>}
        <h2>{decisionPrompt}</h2>
      </div>
      {claimedRole && (
        <aside className="role-reminder" aria-label={`${ROLE_LABELS[claimedRole]} powers`}>
          <img src={roleImage(claimedRole)} alt="" />
          <div>
            <strong>{ROLE_LABELS[claimedRole]}</strong>
            <span>{ROLE_RULES[claimedRole]}</span>
          </div>
        </aside>
      )}
      {(decision.kind === "action" || decision.kind === "block") && (
        <div className="action-legend" aria-label="Action icon legend">
          {decision.kind === "action" && (
            <span title="Basic actions have no character-card icon.">No card: Basic</span>
          )}
          <span title="A full-color character card means you hold the required card.">Color card: In your hand</span>
          <span className="action-legend__bluff" title="A red character card means you do not hold it.">Red card: Bluff</span>
        </div>
      )}
      <div className="decision-options">
        {decision.options.map((option) => (
          <DecisionOption
            key={option.id}
            option={option}
            decisionKind={decision.kind}
            view={view}
            cards={cards}
            disabled={busy}
            onChoose={onChoose}
            onHighlightRole={onHighlightRole}
          />
        ))}
      </div>
    </section>
  );
}

function HistoryPanel({ view }: { view: PublicGameView }) {
  const events = [...view.history.slice(-80)].reverse();
  const latestSequence = events.at(0)?.sequence ?? 0;
  const previousLatest = useRef(latestSequence);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (latestSequence <= previousLatest.current) return;
    previousLatest.current = latestSequence;
    window.requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    });
  }, [latestSequence]);

  return (
    <section className="history-panel">
      <div className="section-heading">
        <span>Court chronicle</span>
        <small>{view.history.length} events</small>
      </div>
      <ol className="history-list" ref={listRef} aria-live="polite">
        {events.map((event, index) => {
          const beginsTurn = index === 0 || events[index - 1].turn !== event.turn;
          return (
            <Fragment key={event.sequence}>
              {beginsTurn && <li className="history-turn">Turn {event.turn}</li>}
              <li className="history-list__event">
                <span className={`event-mark event-mark--${event.type}`} />
                <p>{displayGameText(event.message, view)}</p>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </section>
  );
}

function DebugDrawer({ data, loading, onClose }: {
  data: Record<string, unknown> | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <aside className="debug-drawer">
      <header>
        <div>
          <span className="eyebrow">Developer view</span>
          <h2>Agent diagnostics</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close diagnostics">×</button>
      </header>
      <div className="notice notice--warning">
        This view can reveal every hidden card and spoil a human match.
      </div>
      {loading ? <p className="debug-loading">Consulting the record…</p> : <pre>{JSON.stringify(data, null, 2)}</pre>}
    </aside>
  );
}

function ApiKeyPrompt({
  busy,
  error,
  onSave,
  onDismiss,
}: {
  busy: boolean;
  error: string | null;
  onSave: (apiKey: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="modal-backdrop modal-backdrop--key" role="dialog" aria-modal="true" aria-label="Configure OpenAI">
      <form
        className="key-prompt"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(apiKey.trim());
        }}
      >
        <div className="key-prompt__seal">E</div>
        <p className="eyebrow">A private audience</p>
        <h1>Connect the court</h1>
        <p className="key-prompt__intro">
          EvoCoup needs an OpenAI API key for its players. The key will be sent only to this local
          server, written to the git-ignored <code>.env</code> file, and used for OpenAI calls.
        </p>
        <label className="key-field">
          <span>OpenAI API key</span>
          <div>
            <input
              autoFocus
              autoComplete="off"
              spellCheck={false}
              type={revealed ? "text" : "password"}
              placeholder="sk-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <button type="button" onClick={() => setRevealed((current) => !current)}>
              {revealed ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        {error && <div className="key-prompt__error">{error}</div>}
        <button
          className="primary-button primary-button--large"
          disabled={busy || apiKey.trim().length < 20 || !apiKey.trim().startsWith("sk-")}
        >
          {busy ? "Sealing the key…" : "Save key and continue"}
        </button>
        <button className="key-prompt__later" type="button" disabled={busy} onClick={onDismiss}>
          Continue without a key
        </button>
        <small className="key-prompt__footnote">
          The key is stored as plain text in <code>.env</code> on this computer, like most local
          development credentials. It is never included in game diagnostics.
        </small>
      </form>
    </div>
  );
}

function AgentErrorModal({
  message,
  busy,
  canRetry,
  agentFailure,
  onRetry,
  onDismiss,
}: {
  message: string;
  busy: boolean;
  canRetry: boolean;
  agentFailure: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="modal-backdrop modal-backdrop--error"
      role="dialog"
      aria-modal="true"
      aria-label={agentFailure ? "Agent call failed" : "Game interrupted"}
    >
      <section className="agent-error-modal">
        <button className="icon-button agent-error-modal__close" onClick={onDismiss} aria-label="Close error">
          ×
        </button>
        <div className="agent-error-modal__mark">!</div>
        <p className="eyebrow">{agentFailure ? "Agent call failed" : "Game interrupted"}</p>
        <h1>{agentFailure ? "The game has stopped." : "The court was cleared."}</h1>
        <p className="agent-error-modal__message">{message}</p>
        <div className="agent-error-modal__actions">
          {canRetry && (
            <button className="primary-button" disabled={busy} onClick={onRetry}>
              {busy ? "Retrying…" : "Retry this decision"}
            </button>
          )}
          <button className="secondary-button" disabled={busy} onClick={onDismiss}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

function GameScreen({
  match,
  health,
  busy,
  spectatorPaused,
  debugOpen,
  debugData,
  debugLoading,
  onChoose,
  onStep,
  onSpectatorPaused,
  onNewGame,
  onConfigureKey,
  onToggleDebug,
}: {
  match: MatchPayload;
  health: HealthPayload | null;
  busy: boolean;
  spectatorPaused: boolean;
  debugOpen: boolean;
  debugData: Record<string, unknown> | null;
  debugLoading: boolean;
  onChoose: (id: string) => void;
  onStep: () => void;
  onSpectatorPaused: (paused: boolean) => void;
  onNewGame: () => void;
  onConfigureKey: () => void;
  onToggleDebug: () => void;
}) {
  const view = gameView(match);
  const seatView = isSeatView(match.view) ? match.view : null;
  const winner = view.players.find((player) => player.id === view.winner_id);
  const [highlightedRole, setHighlightedRole] = useState<Role | null>(null);
  const humanPlayer = match.human_player_id
    ? view.players.find((player) => player.id === match.human_player_id)
    : null;
  const presentation = usePresentationTimeline(view, spectatorPaused);
  const courtResult = presentation.result;
  const visualAction = presentation.action;
  const visualActionTarget = visualAction?.target_id
    ? view.players.find((candidate) => candidate.id === visualAction.target_id) ?? null
    : null;
  const resultSequenceActive = presentation.resultActive;
  const visualBlock = presentation.block;
  const visualChallenge = presentation.challenge;
  const replacementHistory = recentCardReplacement(view, match.human_player_id);
  const privateReplacement = seatView?.latest_card_replacement ?? null;
  const replacementPlayer = courtResult?.replacement
    ? view.players.find((player) => player.id === courtResult.replacement?.playerId) ?? null
    : null;
  const proofPlayer = courtResult?.proofReturn
    ? view.players.find((player) => player.id === courtResult.proofReturn?.playerId) ?? null
    : null;
  const winnerPresented = view.winner_id !== null
    && (courtResult?.kind === "winner" || courtResult === null);
  const humanReplacement = courtResult?.replacement?.playerId === match.human_player_id
    && replacementHistory?.sequence === courtResult.sequence
    ? replacementHistory
    : null;
  const thinkingDecisions = new Map(
    (match.thinking_players ?? []).map(({ player_id, decision_kind }) => [
      player_id,
      decision_kind,
    ]),
  );
  const presentationGate = courtResult
    ? {
        key: `result-${courtResult.sequence}`,
        duration: RESULT_DURATION_MS + (courtResult.delayed ? RESULT_ENTRY_DELAY_MS : 0),
      }
    : visualChallenge && !resultSequenceActive
      ? {
          key: `challenge-${latestEventSequence(
            view,
            (event) => event.type === "challenge_declared"
              && event.actor_id === visualChallenge.challenger_id,
          )}`,
          duration: THREAD_DRAW_DURATION_MS,
        }
      : visualBlock && presentation.blockAnimate
        ? {
            key: `block-${latestEventSequence(
              view,
              (event) => event.type === "block_declared"
                && event.actor_id === visualBlock.blocker_id,
            )}`,
            duration: THREAD_DRAW_DURATION_MS,
          }
        : presentation.actionVisible && presentation.actionAnimate
          ? {
              key: `action-${presentation.actionSequence}`,
              duration: THREAD_DRAW_DURATION_MS,
            }
          : { key: null, duration: 0 };
  const presentationReady = usePresentationGate(
    presentationGate.key,
    presentationGate.duration,
    spectatorPaused,
  );

  useEffect(() => {
    if (
      match.mode !== "ai_only"
      || spectatorPaused
      || busy
      || !presentationReady
      || match.status === "finished"
      || match.status === "agent_error"
    ) return;
    const timer = window.setTimeout(onStep, 0);
    return () => window.clearTimeout(timer);
  }, [busy, match.mode, match.status, onStep, presentationReady, spectatorPaused]);

  return (
    <main className={`game-shell${spectatorPaused ? " game-shell--paused" : ""}`}>
      <header className="game-header">
        <div className="game-header__brand">
          <div className="brand-mark brand-mark--small">E</div>
          <div className="brand-copy">
            <strong>EvoCoup</strong>
            <span>Turn {view.turn} · {titleCase(view.phase)}</span>
          </div>
        </div>
        <div className="game-header__status">
          <span className={`status-light status-light--${match.status}`} />
          <div>
            <small>{spectatorPaused ? "Paused" : titleCase(match.mode === "ai_only" && match.status === "paused" ? "running" : match.status)}</small>
            <strong>{statusCopy(match, spectatorPaused)}</strong>
          </div>
        </div>
        <nav className="game-header__actions">
          {!health?.openai_configured && <button className="text-button text-button--key" onClick={onConfigureKey}>Add API key</button>}
          {match.mode === "ai_only" && match.status !== "finished" && match.status !== "agent_error" && (
            <button
              className="text-button spectator-pause"
              aria-pressed={spectatorPaused}
              onClick={() => onSpectatorPaused(!spectatorPaused)}
            >
              {spectatorPaused ? "Resume" : "Pause"}
            </button>
          )}
          <button className="text-button" onClick={onToggleDebug}>Developer</button>
          <button className="secondary-button" onClick={onNewGame}>New game</button>
        </nav>
      </header>

      <div className="game-content">
        <section className="board-wrap">
          <div
            className={`board${spectatorPaused ? " board--paused" : ""}`}
            aria-label="Coup game table"
            style={{
              "--result-duration": `${RESULT_DURATION_MS}ms`,
              "--result-entry-delay": `${RESULT_ENTRY_DELAY_MS}ms`,
              "--thread-draw-duration": `${THREAD_DRAW_DURATION_MS}ms`,
            } as CSSProperties}
          >
            <img className="board__art" src="/images/table.png" alt="Ornate Renaissance game table" />
            <div className="board__vignette" />
            {presentation.actionVisible && visualAction && (
              <ActionThread
                key={`action-${presentation.actionSequence}`}
                action={visualAction}
                view={view}
                canceled={presentation.actionCanceled}
                succeeded={presentation.actionSucceeded}
                pulseTarget={!presentation.resultActive || presentation.actionDelayed}
                animate={presentation.actionAnimate}
                subdued={presentation.actionSubdued}
                concluding={presentation.actionConcluding}
                concludingDelayed={presentation.actionDelayed}
                paused={spectatorPaused}
              />
            )}
            {visualBlock && visualAction && (
              <ResponseThread
                from={visualBlock.blocker_id}
                to={visualAction.actor_id}
                view={view}
                kind="block"
                targetKind="action"
                pulseTarget={!visualChallenge && presentation.blockAnimate}
                animate={presentation.blockAnimate}
                subdued={presentation.blockSubdued}
                concluding={presentation.blockConcluding}
                paused={spectatorPaused}
              />
            )}
            {visualChallenge && (
              <ResponseThread
                from={visualChallenge.challenger_id}
                to={visualChallenge.claimant_id}
                view={view}
                kind="challenge"
                targetKind={visualChallenge.claim_kind}
                pulseTarget={!resultSequenceActive}
                animate={!resultSequenceActive}
                concluding={presentation.challengeConcluding}
                paused={spectatorPaused}
              />
            )}
            {view.players.map((player) => (
              <PlayerSeat
                key={player.id}
                player={player}
                count={view.players.length}
                active={player.id === presentation.activePlayerId}
                human={player.id === match.human_player_id}
                winning={winnerPresented && player.id === view.winner_id}
                revealedRoles={revealedRolesAtPresentation(
                  player,
                  view,
                  courtResult?.sequence ?? null,
                )}
                thinkingLabel={
                  resultSequenceActive
                    ? null
                    : thinkingDecisions.has(player.id)
                    ? thinkingCopy(thinkingDecisions.get(player.id) ?? null)
                    : player.id === match.thinking_player_id
                      ? thinkingCopy(match.thinking_decision_kind)
                      : null
                }
                pendingAction={
                  visualAction?.actor_id === player.id
                    && presentation.actionVisible
                    && (!presentation.resultActive
                      || Boolean(visualAction.claimed_role)
                      || Boolean(visualBlock))
                    ? visualAction
                    : null
                }
                actionTarget={visualActionTarget}
                actionEntering={presentation.actionAnimate}
                actionSubdued={presentation.actionSubdued}
                actionConcluding={presentation.actionConcluding}
                actionConcludingDelayed={presentation.actionDelayed}
                blockingRole={
                  visualBlock?.blocker_id === player.id
                    ? visualBlock.claimed_role
                    : null
                }
                blockEntering={presentation.blockAnimate}
                blockSubdued={presentation.blockSubdued}
                blockConcluding={presentation.blockConcluding}
                challenging={visualChallenge?.challenger_id === player.id}
                outcome={presentation.outcomes.get(player.id) ?? null}
                outcomeDelayed={presentation.actionDelayed}
              />
            ))}
            <TablePieces view={view} />
            {courtResult?.reveal && (
              <InfluenceReveal reveal={courtResult.reveal} view={view} />
            )}
            {courtResult && (
              <CourtResultBanner result={courtResult} delayed={Boolean(courtResult.delayed)} />
            )}
            {!resultSequenceActive
              && busy
              && thinkingDecisions.size === 0
              && !match.thinking_player_id && (
              <div className="deliberating">
                <span className="quill">✦</span>
                <div>
                  <small>The model is considering the court</small>
                  <strong>Awaiting a decision…</strong>
                </div>
              </div>
            )}
          </div>
          {seatView && humanPlayer && (
            <PrivateHand
              cards={seatView.hidden_cards}
              revealedRoles={revealedRolesAtPresentation(
                humanPlayer,
                view,
                courtResult?.sequence ?? null,
              )}
              choosingInitialInfluence={seatView.setup_choices.length > 0}
              highlightedRole={highlightedRole}
              fallen={!humanPlayer.is_alive && view.phase !== "setup_selection"}
              replacement={humanReplacement}
            />
          )}
        </section>

        <aside className="court-sidebar">
          <CourtStatus view={view} />
          <section className="court-record" aria-label="Session court record">
            <span>Court record</span>
            {match.standings.length === 0 ? (
              <small>No completed courts</small>
            ) : (
              match.standings.map((standing) => (
                <small key={standing.name}>
                  <b>{standing.name}</b> {standing.wins}W / {standing.games}G
                </small>
              ))
            )}
          </section>
          {match.pending_human_decision && (
            <DecisionPanel
              decision={match.pending_human_decision}
              view={view}
              cards={seatView?.hidden_cards ?? []}
              busy={busy || !presentationReady}
              onChoose={onChoose}
              onHighlightRole={setHighlightedRole}
            />
          )}
          {match.status === "finished" && winnerPresented && (
            <section className="victory-panel">
              <span className="victory-panel__crown">♛</span>
              <p className="eyebrow">The intrigue is settled</p>
              <h2>{winner ? playerLabel(winner) : "The victor"} wins</h2>
              <button className="primary-button" onClick={onNewGame}>Convene another court</button>
            </section>
          )}
          {!match.pending_human_decision && match.status !== "finished" && !match.last_error && (
            <section className="waiting-panel">
              <span className="waiting-panel__seal">E</span>
              <p>The other players are plotting their next moves.</p>
              {!health?.openai_configured && <small>An OpenAI API key is required for agent decisions.</small>}
            </section>
          )}
          <HistoryPanel view={view} />
        </aside>
      </div>
      {courtResult?.proofReturn && proofPlayer && (
        <ProofReturn
          proof={courtResult.proofReturn}
          playerName={playerLabel(proofPlayer)}
        />
      )}
      {courtResult?.replacement && replacementPlayer && (
        <ReplacementDraw
          playerId={courtResult.replacement.playerId}
          playerName={playerLabel(replacementPlayer)}
          humanCard={
            courtResult.replacement.playerId === match.human_player_id
              && privateReplacement?.sequence === courtResult.sequence
              ? privateReplacement.card
              : null
          }
        />
      )}
      {debugOpen && <DebugDrawer data={debugData} loading={debugLoading} onClose={onToggleDebug} />}
    </main>
  );
}

export default function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [match, setMatch] = useState<MatchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [spectatorPaused, setSpectatorPaused] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<Record<string, unknown> | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const hasMatch = match !== null;

  useEffect(() => {
    let active = true;
    void api.health()
      .then((payload) => {
        if (!active) return;
        setHealth(payload);
        if (!payload.openai_configured) setShowKeyPrompt(true);
      })
      .catch(() => undefined)
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!busy || !hasMatch) return;
    let active = true;
    const poll = () => {
      void api.current()
        .then((payload) => {
          if (!active) return;
          setMatch((current) => {
            if (!current) return payload;
            return gameView(payload).version >= gameView(current).version ? payload : current;
          });
        })
        .catch((caught) => {
          if (!active || !isMissingMatch(caught)) return;
          setMatch(null);
          setError(
            "The local server restarted and its in-memory game was cleared. Start a new court to continue.",
          );
        });
    };
    poll();
    const interval = window.setInterval(poll, 300);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [busy, hasMatch]);

  const configureKey = useCallback(async (apiKey: string) => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const payload = await api.configureOpenAI(apiKey);
      setHealth(payload);
      setShowKeyPrompt(false);
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : "The key could not be saved.");
    } finally {
      setKeyBusy(false);
    }
  }, []);

  const mutate = useCallback(async (operation: () => Promise<MatchPayload>) => {
    setBusy(true);
    setError(null);
    setDismissedError(null);
    try {
      const payload = await operation();
      setMatch(payload);
      return payload;
    } catch (caught) {
      if (isMissingMatch(caught)) {
        setMatch(null);
        setShowSetup(false);
        setError(
          "The local server restarted and its in-memory game was cleared. Start a new court to continue.",
        );
        return null;
      }
      const message = caught instanceof Error ? caught.message : "An unexpected error occurred.";
      setError(message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const startGame = useCallback(async (players: number, mode: MatchMode) => {
    setSpectatorPaused(false);
    const payload = await mutate(() => api.create(players, mode));
    if (payload) setShowSetup(false);
  }, [mutate]);

  const choose = useCallback((optionId: string) => {
    if (!match) return;
    void mutate(() => api.decide(match, optionId));
  }, [match, mutate]);

  const step = useCallback(() => {
    if (busy) return;
    void mutate(() => api.control("step"));
  }, [busy, mutate]);

  const retry = useCallback(() => {
    void mutate(api.retry);
  }, [mutate]);

  const toggleDebug = useCallback(() => {
    setDebugOpen((current) => {
      if (!current) setDebugLoading(true);
      return !current;
    });
  }, []);

  useEffect(() => {
    if (!debugOpen || !match) return;
    let active = true;
    void api.debug()
      .then((payload) => active && setDebugData(payload))
      .catch((caught) => {
        if (active) setDebugData({ error: caught instanceof Error ? caught.message : String(caught) });
      })
      .finally(() => active && setDebugLoading(false));
    return () => {
      active = false;
    };
  }, [debugOpen, match]);

  const app = useMemo(() => {
    if (loading) {
      return (
        <main className="loading-screen">
          <span className="loading-screen__seal">E</span>
          <p>Opening the chamber…</p>
        </main>
      );
    }
    if (!match) return <Landing health={health} busy={busy} onStart={startGame} onConfigureKey={() => setShowKeyPrompt(true)} />;
    return (
      <GameScreen
        match={match}
        health={health}
        busy={busy}
        spectatorPaused={spectatorPaused}
        debugOpen={debugOpen}
        debugData={debugData}
        debugLoading={debugLoading}
        onChoose={choose}
        onStep={step}
        onSpectatorPaused={setSpectatorPaused}
        onNewGame={() => setShowSetup(true)}
        onConfigureKey={() => setShowKeyPrompt(true)}
        onToggleDebug={toggleDebug}
      />
    );
  }, [busy, choose, debugData, debugLoading, debugOpen, health, loading, match, spectatorPaused, startGame, step, toggleDebug]);

  const fatalError = error ?? match?.last_error ?? null;

  return (
    <>
      {app}
      {showSetup && match && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Start a new game">
          <SetupPanel
            openaiConfigured={health?.openai_configured ?? false}
            replacing
            busy={busy}
            onStart={startGame}
            onConfigureKey={() => setShowKeyPrompt(true)}
            onClose={() => setShowSetup(false)}
          />
        </div>
      )}
      {showKeyPrompt && (
        <ApiKeyPrompt
          busy={keyBusy}
          error={keyError}
          onSave={configureKey}
          onDismiss={() => {
            setKeyError(null);
            setShowKeyPrompt(false);
          }}
        />
      )}
      {fatalError && fatalError !== dismissedError && (
        <AgentErrorModal
          message={fatalError}
          busy={busy}
          canRetry={match?.status === "agent_error"}
          agentFailure={error === null && match?.last_error !== null}
          onRetry={retry}
          onDismiss={() => setDismissedError(fatalError)}
        />
      )}
    </>
  );
}
