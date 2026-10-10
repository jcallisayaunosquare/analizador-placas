/**
 * The fuzzy tier: the confusable pairs the vehicle register deliberately does NOT fold,
 * plus the edit distance used to decide whether a read is "the same plate".
 *
 * This is the half of the problem `residents/domain/vehicle.ts` explicitly defers here:
 * "Fuzzy matching belongs where that score exists, not in a uniqueness key."
 */

/**
 * Bidirectional confusable pairs, excluding the three already folded canonically
 * (O/0, Q/0, I/1 - those never reach this tier).
 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['S', '5'],
  ['B', '8'],
  ['Z', '2'],
  ['G', '6'],
  ['D', '0'],
  ['T', '7'],
  ['A', '4'],
  ['E', 'F'],
  ['U', 'V'],
  ['M', 'N'],
];

const SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = (() => {
  const map: Record<string, string[]> = {};
  for (const [a, b] of PAIRS) {
    (map[a] ??= []).push(b);
    (map[b] ??= []).push(a);
  }
  return map;
})();

/**
 * Candidate variants of a normalised plate.
 *
 * ONE substitution at a time, plus the "every ambiguous letter to its digit" variant.
 * Not the power set: for a 7-character plate that is ~8 variants instead of 2^7, and the
 * extra 120 are mis-reads nobody makes. CarVision's `_generate_variants` does the same.
 *
 * The input itself is always first in the returned set.
 */
export function expandVariants(plate: string): string[] {
  const out = new Set<string>([plate]);

  for (let i = 0; i < plate.length; i += 1) {
    const ch = plate[i] as string;
    for (const alt of SUBSTITUTIONS[ch] ?? []) {
      out.add(plate.slice(0, i) + alt + plate.slice(i + 1));
    }
  }

  // The all-letters-to-digits pass: a plate read entirely in the wrong glyph class.
  let allDigits = '';
  let changed = false;
  for (const ch of plate) {
    const alt = (SUBSTITUTIONS[ch] ?? []).find((c) => /\d/.test(c));
    if (alt !== undefined) {
      allDigits += alt;
      changed = true;
    } else {
      allDigits += ch;
    }
  }
  if (changed) out.add(allDigits);

  return [...out];
}

/**
 * Damerau-Levenshtein distance, capped.
 *
 * Damerau rather than plain Levenshtein because transposition is a common OCR error
 * ("1243ABC" for "1234ABC") and Levenshtein charges it as two edits, which would push a
 * genuine match past a distance-1 threshold.
 *
 * `max` lets the caller stop early: nothing above 2 is ever acted on, so computing a
 * distance of 9 is wasted work.
 */
export function damerauLevenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Three rolling rows is all the recurrence needs; the full matrix is never read back.
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr: number[] = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0] as number;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1, // deletion
        (curr[j - 1] as number) + 1, // insertion
        (prev[j - 1] as number) + cost, // substitution
      );
      // transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] as number) + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }

    // Every remaining row can only grow, so a whole row above max ends it.
    if (rowMin > max) return max + 1;

    prev2 = prev;
    prev = curr;
    curr = new Array<number>(b.length + 1);
  }

  return prev[b.length] as number;
}

export interface FuzzyMatch {
  readonly plate: string;
  readonly distance: number;
}

/**
 * The registered plates within `maxDistance` of a read, nearest first.
 *
 * `registered` is expected to be pre-filtered by length (+/-1) at the repository, which
 * is what `ix_vehicle_resident_active` / a length predicate buys. For a residential
 * building the active set is tens of rows, so this is not the bottleneck.
 *
 * Returning ALL ties is deliberate: more than one match at the same distance is
 * ambiguity, and ambiguity goes to review rather than opening the gate for a coin flip.
 */
export function findFuzzyMatches(
  read: string,
  registered: readonly string[],
  maxDistance = 2,
): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const plate of registered) {
    const distance = damerauLevenshtein(read, plate, maxDistance);
    if (distance <= maxDistance) matches.push({ plate, distance });
  }
  return matches.sort((x, y) => x.distance - y.distance || x.plate.localeCompare(y.plate));
}
