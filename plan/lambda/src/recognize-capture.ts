/**
 * The use case. Ports in, event out. No AWS types, no `process.env`, no `console`.
 *
 * The staged shape with early exits is the one structural idea taken from CarVision's
 * `pipeline/orchestrator.py` - and the one correction made to it: every exit here
 * reports WHY it exited, rather than returning `None` and logging at debug level. At a
 * gate, "nothing happened" is the failure you most need to be able to explain.
 */

import { rankCandidates, decide, type Decision, type ScoredCandidate } from './domain/decision.js';
import type {
  CaptureStorage,
  EventPublisher,
  Logger,
  PlateRecognizer,
  PlateRecognizedEvent,
} from './ports.js';
import type { Thresholds } from './domain/decision.js';

export interface RecognizeCaptureConfig {
  readonly maxBytes: number;
  readonly cooldownSeconds: number;
  readonly eventTtlSeconds: number;
  readonly blocklist: readonly string[];
  readonly thresholds: Thresholds;
}

export type Outcome =
  | { readonly kind: 'published'; readonly event: PlateRecognizedEvent; readonly decisionPreview: Decision | null }
  | { readonly kind: 'skipped'; readonly reason: SkipReason };

export type SkipReason =
  | 'ALREADY_PROCESSED'
  | 'OBJECT_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'NO_TEXT_DETECTED';

export interface RecognizeCaptureDeps {
  readonly storage: CaptureStorage;
  readonly recognizer: PlateRecognizer;
  readonly publisher: EventPublisher;
  readonly logger: Logger;
  readonly config: RecognizeCaptureConfig;
}

export async function recognizeCapture(
  deps: RecognizeCaptureDeps,
  input: { bucket: string; key: string },
): Promise<Outcome> {
  const { storage, recognizer, publisher, logger, config } = deps;

  // ---- Stage 1: metadata, and the cheapest possible exit --------------------
  const meta = await storage.head(input.bucket, input.key);

  // Before Rekognition, not after: a replayed S3 notification must not be billed twice.
  if (await publisher.alreadyPublished(meta.captureId)) {
    logger.info('capture already processed', { captureId: meta.captureId, key: input.key });
    return { kind: 'skipped', reason: 'ALREADY_PROCESSED' };
  }

  if (meta.sizeBytes > config.maxBytes) {
    logger.warn('capture exceeds size limit', {
      captureId: meta.captureId,
      sizeBytes: meta.sizeBytes,
      maxBytes: config.maxBytes,
    });
    return { kind: 'skipped', reason: 'OBJECT_TOO_LARGE' };
  }

  if (meta.contentType !== null && !/^image\/(jpeg|png)$/.test(meta.contentType)) {
    logger.warn('unsupported content type', {
      captureId: meta.captureId,
      contentType: meta.contentType,
    });
    return { kind: 'skipped', reason: 'UNSUPPORTED_CONTENT_TYPE' };
  }

  // ---- Stage 2: recognition ------------------------------------------------
  const result = await recognizer.recognize({ bucket: input.bucket, key: input.key });

  if (result.candidates.length === 0) {
    logger.info('no text detected', {
      captureId: meta.captureId,
      engine: result.engine,
      latencyMs: result.latencyMs,
    });
    // Still published: a frame that read nothing is the signal that a camera moved,
    // and the review queue is where that becomes visible. Dropping it hides the fault.
    const empty = buildEvent(meta, input.key, [], null, result);
    await publisher.publishIfAbsent(empty, config.eventTtlSeconds);
    return { kind: 'skipped', reason: 'NO_TEXT_DETECTED' };
  }

  // ---- Stage 3: normalise, expand, score ----------------------------------
  const ranked = rankCandidates(result.candidates, { blocklist: config.blocklist, limit: 8 });
  const best: ScoredCandidate | null = ranked[0] ?? null;

  // ---- Stage 4: a decision PREVIEW, not the decision ----------------------
  //
  // The real decision needs the vehicle register, and the register is in Postgres, which
  // this function cannot reach: no NAT gateway (ADR-016). So `plateIngest`, inside the
  // VPC, calls the SAME pure `decide()` with the registered vehicles loaded. The preview
  // computed here with an empty register is written to the log only, because it answers
  // the one question worth answering from outside the VPC: did we read a plate at all.
  const preview = decide({
    best,
    quality: result.quality,
    registered: [],
    withinCooldown: false,
    thresholds: config.thresholds,
  });

  const event = buildEvent(meta, input.key, ranked, result.quality, result);
  const published = await publisher.publishIfAbsent(event, config.eventTtlSeconds);

  if (!published) {
    // The conditional write lost: a concurrent invocation on the same object got there
    // first. Not an error - exactly-once is the goal and it was achieved.
    logger.info('event already written by a concurrent invocation', {
      captureId: meta.captureId,
    });
    return { kind: 'skipped', reason: 'ALREADY_PROCESSED' };
  }

  logger.info('plate recognized', {
    captureId: meta.captureId,
    cameraId: meta.cameraId,
    plate: best?.plate ?? null,
    score: best?.score ?? null,
    confidence: best?.confidence ?? null,
    quality: result.quality,
    fused: preview.fused,
    previewReason: preview.reason,
    candidateCount: ranked.length,
    latencyMs: result.latencyMs,
  });

  return { kind: 'published', event, decisionPreview: preview };
}

function buildEvent(
  meta: { captureId: string; cameraId: string; capturedAt: string },
  key: string,
  ranked: readonly ScoredCandidate[],
  quality: number | null,
  result: { engine: string; engineVersion: string | null; latencyMs: number },
): PlateRecognizedEvent {
  const best = ranked[0];
  return {
    captureId: meta.captureId,
    cameraId: meta.cameraId,
    capturedAt: meta.capturedAt,
    objectKey: key,
    candidates: ranked.map((c) => ({
      plate: c.plate,
      raw: c.raw,
      confidence: Number(c.confidence.toFixed(4)),
      score: Number(c.score.toFixed(2)),
      ...(c.box !== undefined ? { box: c.box } : {}),
    })),
    best: best === undefined ? null : { plate: best.plate, confidence: Number(best.confidence.toFixed(4)) },
    quality: quality === null ? null : Number(quality.toFixed(4)),
    engine: result.engine,
    engineVersion: result.engineVersion,
    latencyMs: result.latencyMs,
  };
}
