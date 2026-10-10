/**
 * Crop quality as a 0..1 score.
 *
 * CarVision computes this properly: variance of the Laplacian, contrast, Canny edge
 * density and brightness, weighted 0.4/0.2/0.2/0.2 (`pipeline/plate_quality.py`). That
 * needs the decoded pixels, which in a Node zip Lambda means a native image decoder
 * (`sharp`) - a platform-specific binary, an arm64 build matrix and ~30 MB in the
 * bundle, for a signal we can approximate well enough from geometry alone.
 *
 * So this is an HONEST PROXY, not a port of that metric, and it says so:
 *
 *   - `pixelHeight`: how tall the plate is in the frame, in pixels. Below ~16 px of
 *     character height no OCR engine reads a plate reliably, and above ~48 px more
 *     pixels stop helping. This is the dominant term because it is the one thing that
 *     actually predicts a failed read at a gate.
 *   - `confidenceSpread`: how much the engine's per-line confidences disagree. A frame
 *     where one line is read at 0.99 and the rest at 0.4 is a clean frame with one
 *     clean plate; uniform mediocrity across many lines is a bad frame.
 *   - `aspect`: how close the detected box is to a plate's aspect ratio. A Bolivian
 *     plate is roughly 2.2:1 to 4.5:1. A box far outside that is probably a sign.
 *
 * If field measurement shows quality is the limiting signal, the upgrade path is a
 * Laplacian variance over the decoded crop - which is also exactly the moment the
 * Python container option stops being a liability, since it has OpenCV already.
 */

export interface QualityInput {
  /** Height of the plate's bounding box in source pixels. */
  readonly pixelHeight: number;
  /** Width / height of the plate's bounding box. */
  readonly aspect: number;
  /** Every line confidence the engine returned for this frame, 0..1. */
  readonly lineConfidences: readonly number[];
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Below MIN_HEIGHT_PX no engine reads a plate; above GOOD_HEIGHT_PX more pixels stop helping. */
export const MIN_HEIGHT_PX = 16;
export const GOOD_HEIGHT_PX = 48;

export function estimateQuality(input: QualityInput): number {
  const heightScore = clamp01(
    (input.pixelHeight - MIN_HEIGHT_PX) / (GOOD_HEIGHT_PX - MIN_HEIGHT_PX),
  );

  // 2.2:1 .. 4.5:1 is the plausible band; the score falls off linearly outside it.
  const aspectScore =
    input.aspect >= 2.2 && input.aspect <= 4.5
      ? 1
      : clamp01(1 - Math.min(Math.abs(input.aspect - 2.2), Math.abs(input.aspect - 4.5)) / 2);

  const confs = input.lineConfidences;
  let spreadScore = 0.5; // one line tells us nothing about spread; stay neutral.
  if (confs.length > 1) {
    const max = Math.max(...confs);
    const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
    // A clear winner among noisy lines is a good sign, not a bad one.
    spreadScore = clamp01((max - mean) * 2);
  }

  return clamp01(0.6 * heightScore + 0.25 * aspectScore + 0.15 * spreadScore);
}
