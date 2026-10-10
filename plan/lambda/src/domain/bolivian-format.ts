/**
 * Bolivian plate formats and the candidate scoring built on them.
 *
 * The scoring shape is the idea taken from CarVision's `_score_candidate_norm`
 * (additive bonuses for confidence, length, digit presence, format pattern, and a
 * scene-word blocklist). The patterns and the blocklist are ours: CarVision's are
 * Israeli/Palestinian, and its `normalize_plate` even strips a trailing "P", which
 * would mutilate any Bolivian plate ending in P.
 *
 * The patterns BELONG IN CONFIGURATION in production (`allocation_config`), so adding a
 * series the building actually owns is an UPDATE, not a deploy. They are constants here
 * because this scaffold has no database. They must be confirmed against the building's
 * real vehicle register before the thresholds are calibrated.
 */

import { normalizePlate } from './plate.js';

export interface PlateFormat {
  readonly name: string;
  readonly pattern: RegExp;
  readonly bonus: number;
}

export const BOLIVIAN_FORMATS: readonly PlateFormat[] = [
  // "Placa unica" in force since 2010: four digits then three letters.
  { name: 'UNICA_4_3', pattern: /^\d{4}[A-Z]{3}$/, bonus: 100 },
  // Short series of the same scheme.
  { name: 'UNICA_3_3', pattern: /^\d{3}[A-Z]{3}$/, bonus: 80 },
  // Motorcycles.
  { name: 'MOTO', pattern: /^\d{3,4}[A-Z]{2}$/, bonus: 60 },
  // Pre-"placa unica" series still on the road.
  { name: 'LEGACY_3_3', pattern: /^[A-Z]{3}\d{3}$/, bonus: 40 },
  // A check digit read as part of the text.
  { name: 'WITH_CHECK_DIGIT', pattern: /^\d{3,4}[A-Z]{3}\d$/, bonus: 30 },
];

export const PLATE_MIN_LENGTH = 5;
export const PLATE_MAX_LENGTH = 8;

/**
 * Words a gate camera genuinely reads: signage, not plates.
 * CarVision blocklists STREET/PARKING/ONTARIO for the same reason.
 *
 * Written as plain words and folded through `normalizePlate` at load, never by hand:
 * "PARQUEO" canonicalises to "PAR0UE0" (both Q and O fold to zero), and a hand-folded
 * entry is a silent hole in the list. `foldBlocklist` is exported so the same applies to
 * the env-var override.
 */
export const foldBlocklist = (words: readonly string[]): readonly string[] =>
  words.map(normalizePlate).filter((w) => w.length > 0);

export const DEFAULT_BLOCKLIST: readonly string[] = foldBlocklist([
  'PARQUEO',
  'PRIVADO',
  'VISITAS',
  'SALIDA',
  'ENTRADA',
  'RESERVADO',
  'BOLIVIA',
  'LA PAZ',
  'SANTA CRUZ',
  'COCHABAMBA',
  'PROHIBIDO',
  'ESTACIONAR',
  'TAXI',
  'STOP',
]);

export function matchFormat(plate: string): PlateFormat | null {
  return BOLIVIAN_FORMATS.find((f) => f.pattern.test(plate)) ?? null;
}

export const formatBonus = (plate: string): number => matchFormat(plate)?.bonus ?? 0;

/**
 * Scores one normalised candidate. Higher is better; a negative score means "discard".
 *
 * The weights are CarVision's, with the format table swapped for the Bolivian one:
 *   confidence x 100, +2 per character, +20 for digits, +10 for letters,
 *   -200 with no digit at all, -500 outside the length window, plus the format bonus.
 */
export function scoreCandidate(
  plate: string,
  confidence: number,
  blocklist: readonly string[] = DEFAULT_BLOCKLIST,
): number {
  if (plate.length === 0) return Number.NEGATIVE_INFINITY;
  if (blocklist.includes(plate)) return Number.NEGATIVE_INFINITY;

  if (plate.length < PLATE_MIN_LENGTH || plate.length > PLATE_MAX_LENGTH) return -500;

  const hasDigits = /\d/.test(plate);
  const hasLetters = /[A-Z]/.test(plate);

  let score = confidence * 100;
  score += plate.length * 2;
  if (hasDigits) score += 20;
  if (hasLetters) score += 10;
  // A plate with no digit is a word. Every Bolivian series has digits.
  if (!hasDigits) score -= 200;
  // A plate with no letter is not a Bolivian plate either, but it is a plausible
  // mis-read of one, so the penalty is softer than the no-digit case.
  if (!hasLetters) score -= 120;

  return score + formatBonus(plate);
}

/** The floor a candidate must clear to be considered a plate at all. */
export const MIN_ACCEPTABLE_SCORE = 80;
