/**
 * Candidate ranking, confidence fusion, and the access decision table.
 *
 * Pure TypeScript: no I/O, no `async`, no clock read. Same rule as every other
 * `domain/` ring in this backend, and the reason the whole threshold table can be
 * covered by table tests without touching AWS.
 */

import { normalizePlate } from './plate.js';
import { MIN_ACCEPTABLE_SCORE, scoreCandidate, DEFAULT_BLOCKLIST } from './bolivian-format.js';
import { expandVariants, findFuzzyMatches, type FuzzyMatch } from './fuzzy.js';

// ------------------------------------------------------------------ candidates

/** One text line as the OCR engine returned it. */
export interface RawCandidate {
  readonly text: string;
  /** 0..1 */
  readonly confidence: number;
  readonly box?: { left: number; top: number; width: number; height: number } | undefined;
}

export interface ScoredCandidate {
  readonly plate: string;
  readonly raw: string;
  readonly confidence: number;
  readonly score: number;
  readonly box?: { left: number; top: number; width: number; height: number } | undefined;
}

/**
 * Normalises every line, expands its confusable variants, scores them all and returns
 * the best `limit`, highest score first.
 *
 * Variants of the SAME line all carry that line's confidence: the engine was that sure
 * of the pixels, not of our re-spelling. The score is what separates them.
 */
export function rankCandidates(
  raws: readonly RawCandidate[],
  options: { limit?: number; blocklist?: readonly string[] } = {},
): ScoredCandidate[] {
  const limit = options.limit ?? 8;
  const blocklist = options.blocklist ?? DEFAULT_BLOCKLIST;
  const best = new Map<string, ScoredCandidate>();

  for (const raw of raws) {
    const canonical = normalizePlate(raw.text);
    if (canonical.length === 0) continue;

    // The blocklist is checked against the LINE, before expansion, and that is not
    // belt-and-braces. "VISITAS" canonicalises to "V1S1TAS", and the U/V pair expands
    // that to "U1S1TAS" - a string the blocklist has never heard of, which then scores
    // like a plate. The variants of a scene word are scene words; drop the whole line.
    if (blocklist.includes(canonical)) continue;

    for (const variant of expandVariants(canonical)) {
      const score = scoreCandidate(variant, raw.confidence, blocklist);
      if (!Number.isFinite(score) || score < 0) continue;

      const previous = best.get(variant);
      if (previous === undefined || score > previous.score) {
        best.set(variant, {
          plate: variant,
          raw: raw.text,
          confidence: raw.confidence,
          score,
          box: raw.box,
        });
      }
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.plate.localeCompare(b.plate))
    .slice(0, limit);
}

// ------------------------------------------------------------------ confidence

/**
 * Fuses OCR confidence with crop quality.
 *
 * `conf * (0.6 + 0.4 * quality)` - CarVision's formula, kept because it is the right
 * shape: a blurry crop can never reach full confidence, but a perfect crop does not
 * inflate a weak read either. With no quality signal, the confidence stands alone.
 */
export function fuseConfidence(confidence: number, quality: number | null): number {
  const c = Math.max(0, Math.min(1, confidence));
  if (quality === null) return c;
  const q = Math.max(0, Math.min(1, quality));
  return c * (0.6 + 0.4 * q);
}

// ------------------------------------------------------------------ decision

export type PlateReadStatus = 'MATCHED' | 'UNMATCHED' | 'REVIEW' | 'DISCARDED';
export type MatchKind = 'EXACT' | 'FUZZY' | 'MANUAL' | 'NONE';
export type AccessDecision = 'ALLOW' | 'DENY' | 'REVIEW';

export type DecisionReason =
  | 'EXACT_MATCH'
  | 'FUZZY_MATCH_SINGLE'
  | 'FUZZY_MATCH_AMBIGUOUS'
  | 'PLATE_NOT_REGISTERED'
  | 'LOW_CONFIDENCE'
  | 'UNREADABLE'
  | 'RESIDENT_NOT_ELIGIBLE'
  | 'VEHICLE_INACTIVE'
  | 'DUPLICATE_WITHIN_COOLDOWN';

export interface RegisteredVehicle {
  readonly vehicleId: string;
  readonly residentId: string;
  /** Canonical form, as stored in `vehicle.plate`. */
  readonly plate: string;
  readonly isActive: boolean;
  readonly residentIsEligible: boolean;
}

export interface Thresholds {
  /** Automatic ALLOW at or above this fused confidence. */
  readonly minFused: number;
  /** Below this, the read is unreadable and produces no access event at all. */
  readonly reviewFused: number;
  /** Largest edit distance a single fuzzy match may have and still open the gate. */
  readonly maxFuzzyDistance: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minFused: 0.85,
  reviewFused: 0.55,
  maxFuzzyDistance: 1,
};

export interface DecisionInput {
  readonly best: ScoredCandidate | null;
  readonly quality: number | null;
  readonly registered: readonly RegisteredVehicle[];
  readonly withinCooldown: boolean;
  readonly thresholds?: Thresholds;
}

export interface Decision {
  readonly status: PlateReadStatus;
  /** null means: record the read, create NO access event. */
  readonly decision: AccessDecision | null;
  readonly reason: DecisionReason;
  readonly matchKind: MatchKind;
  readonly fused: number;
  readonly plate: string | null;
  readonly vehicleId: string | null;
  readonly residentId: string | null;
  readonly matchDistance: number | null;
  /** Populated when the reason is FUZZY_MATCH_AMBIGUOUS, for the review screen. */
  readonly ambiguousWith: readonly string[];
}

/**
 * The full table from MODULO-PLACAS.md section 5, as one pure function.
 *
 * Order matters and is the point of the function:
 *   cooldown  ->  unreadable  ->  low confidence  ->  exact  ->  fuzzy  ->  unmatched
 * Eligibility and vehicle state are checked only AFTER a plate has been identified,
 * because "not eligible" is a statement about a known resident, not about a blur.
 */
export function decide(input: DecisionInput): Decision {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const best = input.best;
  const fused = best === null ? 0 : fuseConfidence(best.confidence, input.quality);

  const base = {
    fused,
    plate: best?.plate ?? null,
    vehicleId: null,
    residentId: null,
    matchDistance: null,
    ambiguousWith: [] as readonly string[],
  };

  // A car creeping forward is one arrival, not twenty. The frame is still kept as
  // evidence; only the access event is suppressed.
  if (input.withinCooldown) {
    return { ...base, status: 'DISCARDED', decision: null, reason: 'DUPLICATE_WITHIN_COOLDOWN', matchKind: 'NONE' };
  }

  // No candidate cleared the format/score floor, or the fused confidence is too low to
  // call anything. Not a denied entry: a dirty lens or a fast car. A DENY here would
  // poison the denial metric with events that belong to nobody.
  if (best === null || best.score < MIN_ACCEPTABLE_SCORE || fused < t.reviewFused) {
    return { ...base, status: 'REVIEW', decision: null, reason: 'UNREADABLE', matchKind: 'NONE' };
  }

  const exact = input.registered.find((v) => v.plate === best.plate);
  if (exact !== undefined) {
    const identified = {
      ...base,
      plate: exact.plate,
      vehicleId: exact.vehicleId,
      residentId: exact.residentId,
      matchDistance: 0,
      matchKind: 'EXACT' as MatchKind,
    };
    if (!exact.isActive) {
      return { ...identified, status: 'UNMATCHED', decision: 'DENY', reason: 'VEHICLE_INACTIVE' };
    }
    if (!exact.residentIsEligible) {
      return { ...identified, status: 'MATCHED', decision: 'DENY', reason: 'RESIDENT_NOT_ELIGIBLE' };
    }
    if (fused < t.minFused) {
      // Identified, but not confidently enough to open on its own. An administrator
      // confirms in one click, and the correction becomes a labelled evaluation sample.
      return { ...identified, status: 'REVIEW', decision: 'REVIEW', reason: 'LOW_CONFIDENCE' };
    }
    return { ...identified, status: 'MATCHED', decision: 'ALLOW', reason: 'EXACT_MATCH' };
  }

  // No exact hit. Only now is the fuzzy tier worth its cost.
  const activePlates = input.registered.filter((v) => v.isActive).map((v) => v.plate);
  const fuzzy: FuzzyMatch[] = findFuzzyMatches(best.plate, activePlates, t.maxFuzzyDistance);
  const nearest = fuzzy.filter((m) => m.distance === fuzzy[0]?.distance);

  if (nearest.length > 1) {
    // Two registered plates equally close. Opening would be picking at random whose
    // entry this was, and the log would assert something untrue.
    return {
      ...base,
      status: 'REVIEW',
      decision: 'REVIEW',
      reason: 'FUZZY_MATCH_AMBIGUOUS',
      matchKind: 'FUZZY',
      matchDistance: nearest[0]?.distance ?? null,
      ambiguousWith: nearest.map((m) => m.plate),
    };
  }

  if (nearest.length === 1) {
    const hit = nearest[0] as FuzzyMatch;
    const vehicle = input.registered.find((v) => v.plate === hit.plate) as RegisteredVehicle;
    const identified = {
      ...base,
      plate: vehicle.plate,
      vehicleId: vehicle.vehicleId,
      residentId: vehicle.residentId,
      matchDistance: hit.distance,
      matchKind: 'FUZZY' as MatchKind,
    };
    if (!vehicle.residentIsEligible) {
      return { ...identified, status: 'MATCHED', decision: 'DENY', reason: 'RESIDENT_NOT_ELIGIBLE' };
    }
    if (fused < t.minFused) {
      return { ...identified, status: 'REVIEW', decision: 'REVIEW', reason: 'LOW_CONFIDENCE' };
    }
    return { ...identified, status: 'MATCHED', decision: 'ALLOW', reason: 'FUZZY_MATCH_SINGLE' };
  }

  if (fused < t.minFused) {
    return { ...base, status: 'REVIEW', decision: 'REVIEW', reason: 'LOW_CONFIDENCE', matchKind: 'NONE' };
  }

  // Read clearly, registered nowhere: a visitor or an intruder. A fact, not a doubt.
  // A visitor lane is a separate feature (a temporary plate with an expiry), not a
  // loosened threshold.
  return { ...base, status: 'UNMATCHED', decision: 'DENY', reason: 'PLATE_NOT_REGISTERED', matchKind: 'NONE' };
}
