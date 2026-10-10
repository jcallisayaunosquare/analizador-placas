/**
 * The canonical plate form.
 *
 * This is a VERBATIM port of `normalizePlate` from
 * `apps/api/src/modules/residents/domain/vehicle.ts`. It is duplicated here only
 * because this scaffold is deliberately standalone; when the module lands in
 * `apps/api/src/modules/plates/` this file is DELETED and the residents' domain
 * function is imported instead.
 *
 * Why that matters: `vehicle.plate` is stored folded by that function and
 * `ux_vehicle_plate_active` is keyed on it. Two definitions of "the same plate" would
 * let "already registered" and "recognised at the gate" disagree, and the gate would
 * refuse a car that is registered.
 *
 * Folded, both directions, to the digit: O -> 0, Q -> 0, I -> 1. Nothing else.
 * S/5, B/8, Z/2, G/6, D/0 are real OCR confusions but folding them in a uniqueness key
 * creates false collisions a resident cannot act on. They belong in the fuzzy tier,
 * where a confidence score and a review queue exist. See ./fuzzy.ts.
 */

const CONFUSABLES: Readonly<Record<string, string>> = { O: '0', Q: '0', I: '1' };

export const PLATE_PATTERN = /^[A-Z0-9]{2,20}$/;

/** Idempotent: normalizePlate(normalizePlate(x)) === normalizePlate(x). */
export function normalizePlate(raw: string): string {
  const stripped = raw
    .normalize('NFD')
    // Combining marks: the tail of a decomposed accented letter.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9a-zA-Z]/g, '')
    .toUpperCase();

  let out = '';
  for (const ch of stripped) out += CONFUSABLES[ch] ?? ch;
  return out;
}

/** Whether a recognised plate and a registered one are the same plate. */
export const platesMatch = (a: string, b: string): boolean => {
  const na = normalizePlate(a);
  return na.length > 0 && na === normalizePlate(b);
};
