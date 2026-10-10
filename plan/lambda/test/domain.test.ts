/**
 * Table tests over the whole domain ring. No AWS, no network, no clock.
 *
 * This is the point of keeping `decide()` pure: the threshold table of
 * MODULO-PLACAS.md section 5 is verified end to end in milliseconds, the same way the
 * raffle is verified 10 000 times without touching the cloud.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlate, platesMatch } from '../src/domain/plate.js';
import { scoreCandidate, matchFormat, MIN_ACCEPTABLE_SCORE } from '../src/domain/bolivian-format.js';
import { expandVariants, damerauLevenshtein, findFuzzyMatches } from '../src/domain/fuzzy.js';
import { estimateQuality } from '../src/domain/quality.js';
import {
  decide,
  fuseConfidence,
  rankCandidates,
  DEFAULT_THRESHOLDS,
  type RegisteredVehicle,
} from '../src/domain/decision.js';

// ------------------------------------------------------------- normalisation

test('normalizePlate strips separators and folds O/Q/I', () => {
  for (const [input, expected] of [
    ['1234 ABC', '1234ABC'],
    ['1234-ABC', '1234ABC'],
    ['1234.ABC', '1234ABC'],
    ['  1234abc  ', '1234ABC'],
    ['O123ABC', '0123ABC'],
    ['Q123ABC', '0123ABC'],
    ['I234ABC', '1234ABC'],
    ['ÑÁ12', 'NA12'],
  ] as const) {
    assert.equal(normalizePlate(input), expected, input);
  }
});

test('normalizePlate is idempotent', () => {
  for (const s of ['1234ABC', 'O1I2Q3', 'abc-123', '']) {
    assert.equal(normalizePlate(normalizePlate(s)), normalizePlate(s));
  }
});

test('normalizePlate does NOT fold S/5, B/8, Z/2 — those are the fuzzy tier', () => {
  assert.equal(normalizePlate('1234A8C'), '1234A8C');
  assert.equal(normalizePlate('1Z34ABC'), '1Z34ABC');
});

test('empty input never matches, so a blank read cannot open a gate', () => {
  assert.equal(platesMatch('', ''), false);
  assert.equal(platesMatch('---', '1234ABC'), false);
  assert.equal(platesMatch('1234 ABC', '1234-abc'), true);
});

// ------------------------------------------------------------ format scoring

test('Bolivian formats are recognised and ranked', () => {
  assert.equal(matchFormat('1234ABC')?.name, 'UNICA_4_3');
  assert.equal(matchFormat('123ABC')?.name, 'UNICA_3_3');
  assert.equal(matchFormat('1234AB')?.name, 'MOTO');
  assert.equal(matchFormat('ABC123')?.name, 'LEGACY_3_3');
  assert.equal(matchFormat('WHATEVER'), null);
});

test('a plate in the current format outscores the same confidence in no format', () => {
  assert.ok(scoreCandidate('1234ABC', 0.9) > scoreCandidate('AB12CD34', 0.9));
});

test('a candidate with no digits is rejected outright', () => {
  assert.ok(scoreCandidate('ABCDEFG', 0.99) < MIN_ACCEPTABLE_SCORE);
});

test('blocklisted scene words score -Infinity', () => {
  // "PARQUEO" normalises to PARQUE0 (O -> 0), which is what the list holds.
  assert.equal(scoreCandidate(normalizePlate('PARQUEO'), 0.99), Number.NEGATIVE_INFINITY);
});

test('length outside 5..8 is rejected', () => {
  assert.ok(scoreCandidate('1A2', 0.99) < 0);
  assert.ok(scoreCandidate('123456789', 0.99) < 0);
});

// -------------------------------------------------------------------- fuzzy

test('expandVariants makes one substitution at a time, not the power set', () => {
  const variants = expandVariants('1234A8C');
  assert.ok(variants.includes('1234A8C'), 'the input itself');
  assert.ok(variants.includes('1234ABC'), '8 -> B');
  // 7 chars, a handful of ambiguous ones: single-digit count, never 2^7.
  assert.ok(variants.length < 20, `got ${variants.length}`);
});

test('damerauLevenshtein charges a transposition as one edit', () => {
  assert.equal(damerauLevenshtein('1234ABC', '1234ABC'), 0);
  assert.equal(damerauLevenshtein('1243ABC', '1234ABC'), 1, 'transposition');
  assert.equal(damerauLevenshtein('1234ABC', '1234AB'), 1, 'deletion');
  assert.equal(damerauLevenshtein('1234ABX', '1234ABC'), 1, 'substitution');
});

test('damerauLevenshtein respects the cap and stops early', () => {
  assert.ok(damerauLevenshtein('AAAAAAAA', '99999999', 2) > 2);
});

test('findFuzzyMatches returns every tie, nearest first', () => {
  const matches = findFuzzyMatches('1234ABC', ['1234ABD', '1234ABX', '9999ZZZ'], 1);
  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map((m) => m.distance),
    [1, 1],
  );
});

// ------------------------------------------------------------------ quality

test('quality rises with plate pixel height', () => {
  const low = estimateQuality({ pixelHeight: 14, aspect: 3, lineConfidences: [0.9] });
  const high = estimateQuality({ pixelHeight: 60, aspect: 3, lineConfidences: [0.9] });
  assert.ok(high > low);
  assert.ok(low >= 0 && high <= 1);
});

test('a sign-shaped box scores worse than a plate-shaped one', () => {
  const plate = estimateQuality({ pixelHeight: 40, aspect: 3, lineConfidences: [0.9] });
  const banner = estimateQuality({ pixelHeight: 40, aspect: 12, lineConfidences: [0.9] });
  assert.ok(plate > banner);
});

// --------------------------------------------------------------- confidence

test('fuseConfidence never exceeds the OCR confidence and never zeroes it', () => {
  assert.equal(fuseConfidence(0.9, null), 0.9);
  assert.equal(fuseConfidence(0.9, 1), 0.9);
  assert.ok(Math.abs(fuseConfidence(0.9, 0) - 0.54) < 1e-9);
  assert.ok(fuseConfidence(0.9, 0.5) < 0.9);
});

// --------------------------------------------------------------- ranking

test('rankCandidates picks the plate out of a frame full of signage', () => {
  const ranked = rankCandidates([
    { text: 'PARQUEO', confidence: 0.98 },
    { text: 'VISITAS', confidence: 0.95 },
    { text: '1234 ABC', confidence: 0.91 },
  ]);
  assert.equal(ranked[0]?.plate, '1234ABC');
});

test('a scene word cannot escape the blocklist through variant expansion', () => {
  // Regression. "VISITAS" canonicalises to V1S1TAS (I -> 1); the U/V confusable pair
  // then expands that to U1S1TAS, which is not in the blocklist and scores like a
  // 7-character plate. The blocklist is therefore checked on the LINE, before expansion.
  assert.deepEqual(rankCandidates([{ text: 'VISITAS', confidence: 0.99 }]), []);
  assert.deepEqual(rankCandidates([{ text: 'PARQUEO', confidence: 0.99 }]), []);
  assert.deepEqual(rankCandidates([{ text: 'PARQUEO PRIVADO', confidence: 0.99 }]), []);
});

test('rankCandidates surfaces the corrected variant above the raw mis-read', () => {
  const ranked = rankCandidates([{ text: '1234A8C', confidence: 0.88 }]);
  // 1234ABC matches UNICA_4_3 (+100); 1234A8C matches nothing.
  assert.equal(ranked[0]?.plate, '1234ABC');
  assert.equal(ranked[0]?.raw, '1234A8C');
});

// ---------------------------------------------------------------- decisions

const vehicle = (over: Partial<RegisteredVehicle> = {}): RegisteredVehicle => ({
  vehicleId: 'v-1',
  residentId: 'r-1',
  plate: '1234ABC',
  isActive: true,
  residentIsEligible: true,
  ...over,
});

const bestOf = (plate: string, confidence: number) =>
  rankCandidates([{ text: plate, confidence }])[0] ?? null;

test('high confidence + exact match = ALLOW', () => {
  const d = decide({
    best: bestOf('1234ABC', 0.98),
    quality: 0.9,
    registered: [vehicle()],
    withinCooldown: false,
  });
  assert.equal(d.decision, 'ALLOW');
  assert.equal(d.reason, 'EXACT_MATCH');
  assert.equal(d.matchKind, 'EXACT');
  assert.equal(d.matchDistance, 0);
  assert.equal(d.vehicleId, 'v-1');
});

test('high confidence + single fuzzy match at distance 1 = ALLOW', () => {
  // Read "1234ABD": one substitution away from the registered 1234ABC, and 1234ABD is
  // itself a valid format, so the ranker does not silently repair it.
  const d = decide({
    best: bestOf('1234ABD', 0.99),
    quality: 1,
    registered: [vehicle()],
    withinCooldown: false,
  });
  assert.equal(d.decision, 'ALLOW');
  assert.equal(d.reason, 'FUZZY_MATCH_SINGLE');
  assert.equal(d.matchDistance, 1);
});

test('two registered plates equally close = REVIEW, never a coin flip', () => {
  const d = decide({
    best: bestOf('1234ABD', 0.99),
    quality: 1,
    registered: [vehicle(), vehicle({ vehicleId: 'v-2', residentId: 'r-2', plate: '1234ABX' })],
    withinCooldown: false,
  });
  assert.equal(d.decision, 'REVIEW');
  assert.equal(d.reason, 'FUZZY_MATCH_AMBIGUOUS');
  assert.equal(d.vehicleId, null, 'no vehicle may be attributed');
  assert.equal(d.ambiguousWith.length, 2);
});

test('read clearly but not registered = DENY, not REVIEW', () => {
  const d = decide({
    best: bestOf('9876ZYX', 0.99),
    quality: 1,
    registered: [vehicle()],
    withinCooldown: false,
  });
  assert.equal(d.decision, 'DENY');
  assert.equal(d.reason, 'PLATE_NOT_REGISTERED');
  assert.equal(d.status, 'UNMATCHED');
});

test('fused between the two thresholds = REVIEW', () => {
  // 0.8 * (0.6 + 0.4 * 0.2) = 0.544 -> just under reviewFused, so push quality up.
  const d = decide({
    best: bestOf('9876ZYX', 0.8),
    quality: 0.8,
    registered: [],
    withinCooldown: false,
  });
  assert.ok(d.fused > DEFAULT_THRESHOLDS.reviewFused && d.fused < DEFAULT_THRESHOLDS.minFused);
  assert.equal(d.decision, 'REVIEW');
  assert.equal(d.reason, 'LOW_CONFIDENCE');
});

test('fused below the floor produces NO access event', () => {
  const d = decide({
    best: bestOf('1234ABC', 0.5),
    quality: 0.1,
    registered: [vehicle()],
    withinCooldown: false,
  });
  assert.equal(d.decision, null, 'an unreadable frame is not a denied entry');
  assert.equal(d.reason, 'UNREADABLE');
  assert.equal(d.status, 'REVIEW');
});

test('no candidate at all = UNREADABLE, no event', () => {
  const d = decide({ best: null, quality: null, registered: [vehicle()], withinCooldown: false });
  assert.equal(d.decision, null);
  assert.equal(d.reason, 'UNREADABLE');
});

test('cooldown discards the event but the read is still recorded', () => {
  const d = decide({
    best: bestOf('1234ABC', 0.99),
    quality: 1,
    registered: [vehicle()],
    withinCooldown: true,
  });
  assert.equal(d.status, 'DISCARDED');
  assert.equal(d.decision, null);
  assert.equal(d.reason, 'DUPLICATE_WITHIN_COOLDOWN');
});

test('an ineligible resident is identified and denied', () => {
  const d = decide({
    best: bestOf('1234ABC', 0.99),
    quality: 1,
    registered: [vehicle({ residentIsEligible: false })],
    withinCooldown: false,
  });
  assert.equal(d.decision, 'DENY');
  assert.equal(d.reason, 'RESIDENT_NOT_ELIGIBLE');
  assert.equal(d.residentId, 'r-1', 'the log must still say who it was');
});

test('a deactivated vehicle is denied', () => {
  const d = decide({
    best: bestOf('1234ABC', 0.99),
    quality: 1,
    registered: [vehicle({ isActive: false })],
    withinCooldown: false,
  });
  assert.equal(d.decision, 'DENY');
  assert.equal(d.reason, 'VEHICLE_INACTIVE');
});

test('a plate registered with an O matches a read of a 0', () => {
  // The register stored normalizePlate("O123ABC") = "0123ABC".
  const d = decide({
    best: bestOf('0123ABC', 0.99),
    quality: 1,
    registered: [vehicle({ plate: normalizePlate('O123ABC') })],
    withinCooldown: false,
  });
  assert.equal(d.reason, 'EXACT_MATCH');
});
