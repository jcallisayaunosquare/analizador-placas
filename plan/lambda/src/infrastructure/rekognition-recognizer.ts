/**
 * The one class that knows Rekognition exists.
 *
 * `DetectText` is given the S3 object directly, so the JPEG never travels through this
 * function: no download, no 5 MB `Bytes` payload, no decode. That is both the fast path
 * and the cheap one.
 *
 * What it does NOT do, on purpose: localise the plate. Rekognition has no plate
 * detector. The localisation here is "a text line that scores as a Bolivian plate
 * format and sits in a plate-shaped box", which is why the format table and the scene
 * blocklist in the domain are load-bearing rather than cosmetic.
 */

import {
  RekognitionClient,
  DetectTextCommand,
  type TextDetection,
} from '@aws-sdk/client-rekognition';

import type { PlateRecognizer, RecognitionRequest, RecognitionResult } from '../ports.js';
import type { RawCandidate } from '../domain/decision.js';
import { estimateQuality } from '../domain/quality.js';
import { normalizePlate } from '../domain/plate.js';
import { formatBonus } from '../domain/bolivian-format.js';

export interface RekognitionRecognizerOptions {
  /** Lines below this confidence are not worth scoring. Percent, 0..100. */
  readonly minTextConfidence?: number;
  /**
   * Source frame height in pixels. Rekognition returns normalised boxes, so the
   * absolute plate height - the signal that predicts a failed read - needs this.
   * Comes from the camera profile; 1080 is the default because that is what the gate
   * cameras are specified at.
   */
  readonly frameHeightPx?: number;
}

export class RekognitionPlateRecognizer implements PlateRecognizer {
  private readonly minTextConfidence: number;
  private readonly frameHeightPx: number;

  constructor(
    private readonly client: RekognitionClient,
    options: RekognitionRecognizerOptions = {},
  ) {
    this.minTextConfidence = options.minTextConfidence ?? 70;
    this.frameHeightPx = options.frameHeightPx ?? 1080;
  }

  async recognize(request: RecognitionRequest): Promise<RecognitionResult> {
    const startedAt = Date.now();

    const response = await this.client.send(
      new DetectTextCommand({
        Image: { S3Object: { Bucket: request.bucket, Name: request.key } },
        Filters: {
          WordFilter: {
            // A plate is at least 5 characters; shorter words are never the plate and
            // filtering them server-side is free.
            MinBoundingBoxHeight: 0.01,
            MinConfidence: this.minTextConfidence,
          },
        },
      }),
    );

    const latencyMs = Date.now() - startedAt;
    const detections = response.TextDetections ?? [];

    // LINE, not WORD: "1234 ABC" is one line and two words, and the line keeps the
    // reading order. The words are only used for the geometry of the best line.
    const lines = detections.filter(
      (d) => d.Type === 'LINE' && (d.Confidence ?? 0) >= this.minTextConfidence,
    );

    const candidates: RawCandidate[] = lines.map((line) => ({
      text: line.DetectedText ?? '',
      confidence: (line.Confidence ?? 0) / 100,
      box: boxOf(line),
    }));

    return {
      candidates,
      quality: this.qualityOf(lines),
      engine: 'rekognition-detect-text',
      // Rekognition does not version DetectText in its response. The month is recorded
      // so a precision regression can be attributed to a model change on their side.
      engineVersion: new Date().toISOString().slice(0, 7),
      latencyMs,
    };
  }

  /**
   * Quality from the geometry of the most plate-like line in the frame, not from the
   * frame as a whole: a dark photo with one well-lit plate is a good capture.
   */
  private qualityOf(lines: readonly TextDetection[]): number | null {
    if (lines.length === 0) return null;

    const confidences = lines.map((l) => (l.Confidence ?? 0) / 100);

    // "Most plate-like" = highest Bolivian format bonus, then widest box.
    const ranked = [...lines].sort((a, b) => {
      const fa = formatBonus(normalizePlate(a.DetectedText ?? ''));
      const fb = formatBonus(normalizePlate(b.DetectedText ?? ''));
      if (fa !== fb) return fb - fa;
      return (boxOf(b)?.width ?? 0) - (boxOf(a)?.width ?? 0);
    });

    const box = boxOf(ranked[0] as TextDetection);
    if (box === undefined || box.height <= 0) return null;

    return estimateQuality({
      pixelHeight: box.height * this.frameHeightPx,
      aspect: box.width / box.height,
      lineConfidences: confidences,
    });
  }
}

function boxOf(
  detection: TextDetection,
): { left: number; top: number; width: number; height: number } | undefined {
  const b = detection.Geometry?.BoundingBox;
  if (b === undefined) return undefined;
  const { Left, Top, Width, Height } = b;
  if (Left === undefined || Top === undefined || Width === undefined || Height === undefined) {
    return undefined;
  }
  return { left: Left, top: Top, width: Width, height: Height };
}
