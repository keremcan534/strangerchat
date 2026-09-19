/**
 * §5 — candidate scoring.
 *
 * Kept pure and synchronous: everything that needs I/O (block lists, "have
 * these two met before") is resolved into a PairContext by the caller. That
 * makes the ranking rules directly testable.
 *
 * Note on the weights: the document's weight table and its worked example
 * disagree slightly — the table says "common interest +30, additional
 * interests +10 each", while the example scores two shared interests as
 * 30 + 30. The table is implemented here because it is the normative list, and
 * both readings produce the same ordering in the document's own example
 * (same-language 140 vs cross-language 20). Every weight is configurable, so
 * the other reading is one env var away.
 */
import type { ScoredCandidate, WaitingEntry } from '../types.js';
import { config } from '../config/index.js';

export interface PairContext {
  blocked: boolean;
  sameAbuseCluster: boolean;
  matchedBefore: boolean;
  recentlyLeft: boolean;
}

export const NEUTRAL_CONTEXT: PairContext = {
  blocked: false,
  sameAbuseCluster: false,
  matchedBefore: false,
  recentlyLeft: false,
};

export type ScoringWeights = typeof config.matching.weights;

export function commonInterests(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  return a.filter((i) => bSet.has(i));
}

export function scorePair(
  seeker: WaitingEntry,
  candidate: WaitingEntry,
  ctx: PairContext = NEUTRAL_CONTEXT,
  weights: ScoringWeights = config.matching.weights,
  rejectThreshold: number = config.matching.rejectScoreThreshold,
): ScoredCandidate {
  const reasons: string[] = [];
  let score = 0;

  const sameLanguage = seeker.language === candidate.language;
  if (sameLanguage) {
    score += weights.sameLanguage;
    reasons.push(`same-language +${weights.sameLanguage}`);
  }

  const shared = commonInterests(seeker.interests, candidate.interests);
  if (shared.length > 0) {
    score += weights.firstCommonInterest;
    reasons.push(`common-interest +${weights.firstCommonInterest}`);
    if (shared.length > 1) {
      const extra = weights.extraCommonInterest * (shared.length - 1);
      score += extra;
      reasons.push(`extra-interests +${extra}`);
    }
  }

  if (!ctx.matchedBefore) {
    score += weights.neverMatchedBefore;
    reasons.push(`never-matched +${weights.neverMatchedBefore}`);
  }

  const translationRequired = !sameLanguage;
  if (translationRequired) {
    score += weights.translationRequired;
    reasons.push(`translation ${weights.translationRequired}`);
  }

  if (ctx.recentlyLeft) {
    score += weights.recentlyLeft;
    reasons.push(`recently-left ${weights.recentlyLeft}`);
  }

  if (ctx.blocked) {
    score += weights.blocked;
    reasons.push(`blocked ${weights.blocked}`);
  }

  if (ctx.sameAbuseCluster) {
    score += weights.sameAbuseCluster;
    reasons.push(`abuse-cluster ${weights.sameAbuseCluster}`);
  }

  return {
    entry: candidate,
    score,
    translationRequired,
    commonInterests: shared,
    // A hard exclusion must never be outweighed by a pile of positives, so the
    // -9999 weights are also enforced as an absolute cut-off.
    rejected: score <= rejectThreshold,
    reasons,
  };
}
