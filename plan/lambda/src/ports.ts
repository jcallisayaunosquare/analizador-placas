/**
 * The application ring: ports only. Nothing here knows that AWS exists.
 *
 * `PlateRecognizer` is the port that makes the engine choice reversible. Moving from
 * Rekognition to a Python container (option a) or to a hosted ALPR API (option c) is one
 * new class in `infrastructure/` and one line in the composition root. The domain, the
 * schema and the HTTP contract do not change. That is the whole reason the engine
 * decision can be made on today's evidence instead of on a guess.
 */

import type { RawCandidate } from './domain/decision.js';
import type { RegisteredVehicle } from './domain/decision.js';

export interface RecognitionRequest {
  readonly bucket: string;
  readonly key: string;
}

export interface RecognitionResult {
  readonly candidates: readonly RawCandidate[];
  /** 0..1, or null when the engine gives nothing to estimate it from. */
  readonly quality: number | null;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly latencyMs: number;
}

export interface PlateRecognizer {
  recognize(request: RecognitionRequest): Promise<RecognitionResult>;
}

/** Reads the resident vehicle register. Implemented over Kysely in `apps/api`. */
export interface VehicleLookup {
  /**
   * Active vehicles whose canonical plate is within one character of `plate`'s length.
   * The length filter is what keeps the fuzzy pass cheap; the distance itself is
   * computed in the domain.
   */
  candidatesFor(plate: string): Promise<readonly RegisteredVehicle[]>;
}

/** The per-(camera, plate) dedupe window. DynamoDB with TTL in `apps/api`. */
export interface CooldownStore {
  /** True when this plate was already seen at this camera inside the window. */
  check(cameraId: string, plate: string): Promise<boolean>;
  mark(cameraId: string, plate: string, ttlSeconds: number): Promise<void>;
}

export interface PlateRecognizedEvent {
  readonly captureId: string;
  readonly cameraId: string;
  readonly capturedAt: string;
  readonly objectKey: string;
  readonly candidates: readonly unknown[];
  readonly best: { plate: string; confidence: number } | null;
  readonly quality: number | null;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly latencyMs: number;
}

/** Writes the event the in-VPC consumer applies to Postgres. */
export interface EventPublisher {
  /** False when an event for this captureId already exists: the capture was processed. */
  publishIfAbsent(event: PlateRecognizedEvent, ttlSeconds: number): Promise<boolean>;
  alreadyPublished(captureId: string): Promise<boolean>;
}

export interface CaptureMetadata {
  readonly captureId: string;
  readonly cameraId: string;
  readonly capturedAt: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

export interface CaptureStorage {
  head(bucket: string, key: string): Promise<CaptureMetadata>;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
