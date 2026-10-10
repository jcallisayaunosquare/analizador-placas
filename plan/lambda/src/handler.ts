/**
 * The composition root and the Lambda entry point.
 *
 * Mirrors `apps/api/src/main/*`: this is the only file that calls `new`, reads
 * `process.env` or imports an AWS SDK client. In the real module this becomes
 * `apps/api/src/main/plate-recognizer.ts` - and note the filename has no dot in it,
 * because the Node runtime splits the handler string at the FIRST dot and
 * `plate-recognizer.handler.ts` fails at init with `Cannot find module`.
 *
 * Clients are constructed at module scope so a warm container reuses the connection
 * pool and the credential provider across invocations.
 */

import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { RekognitionPlateRecognizer } from './infrastructure/rekognition-recognizer.js';
import {
  DynamoEventPublisher,
  S3CaptureStorage,
  consoleLogger,
} from './infrastructure/aws-adapters.js';
import { recognizeCapture, type RecognizeCaptureDeps } from './recognize-capture.js';
import { DEFAULT_BLOCKLIST, foldBlocklist } from './domain/bolivian-format.js';
import { DEFAULT_THRESHOLDS } from './domain/decision.js';

const region = process.env['AWS_REGION'] ?? 'us-east-2';

const rekognition = new RekognitionClient({ region });
const s3 = new S3Client({ region });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (name: string, fallback: readonly string[]): readonly string[] => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  // Folded through normalizePlate, not merely uppercased: the list is compared against
  // canonical candidates, so "PARQUEO" has to become "PAR0UE0" to ever match one.
  return foldBlocklist(raw.split(','));
};

export const deps = (): RecognizeCaptureDeps => ({
  storage: new S3CaptureStorage(s3),
  recognizer: new RekognitionPlateRecognizer(rekognition, {
    minTextConfidence: num('REKOGNITION_MIN_TEXT_CONFIDENCE', 70),
    frameHeightPx: num('CAMERA_FRAME_HEIGHT_PX', 1080),
  }),
  publisher: new DynamoEventPublisher(
    dynamo,
    process.env['EVENTS_TABLE'] ?? 'pacs-events-dev',
  ),
  logger: consoleLogger('pacs-plates'),
  config: {
    maxBytes: num('CAPTURE_MAX_BYTES', 8 * 1024 * 1024),
    cooldownSeconds: num('PLATES_COOLDOWN_SECONDS', 30),
    // 14 days: long enough that a broken in-VPC consumer can be fixed and the stream
    // replayed, short enough that the durable record stays Postgres' job.
    eventTtlSeconds: num('PLATES_EVENT_TTL_SECONDS', 14 * 24 * 3600),
    blocklist: list('PLATE_BLOCKLIST', DEFAULT_BLOCKLIST),
    thresholds: {
      minFused: num('PLATES_MIN_FUSED', DEFAULT_THRESHOLDS.minFused),
      reviewFused: num('PLATES_REVIEW_FUSED', DEFAULT_THRESHOLDS.reviewFused),
      maxFuzzyDistance: num('PLATES_MAX_FUZZY_DISTANCE', DEFAULT_THRESHOLDS.maxFuzzyDistance),
    },
  },
});

// Minimal shape of the S3 notification. Typed locally rather than pulling in
// @types/aws-lambda for one interface.
interface S3Event {
  Records?: {
    s3?: { bucket?: { name?: string }; object?: { key?: string } };
  }[];
}

export async function handler(event: S3Event): Promise<{ processed: number; skipped: number }> {
  const d = deps();
  let processed = 0;
  let skipped = 0;

  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const rawKey = record.s3?.object?.key;
    if (bucket === undefined || rawKey === undefined) {
      d.logger.warn('record without bucket or key', {});
      skipped += 1;
      continue;
    }

    // S3 URL-encodes the key in the notification and turns spaces into '+'. A key with
    // a space that is not decoded produces a GetObject 404 that looks like a missing
    // object rather than an encoding bug.
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));

    try {
      const outcome = await recognizeCapture(d, { bucket, key });
      if (outcome.kind === 'published') processed += 1;
      else skipped += 1;
    } catch (error) {
      // Rethrow: an S3-triggered invocation that fails is retried twice by Lambda and
      // then goes to the configured destination. Swallowing it would lose the capture
      // silently, and a lost capture at a gate is a car with no record of entering.
      d.logger.error('recognition failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return { processed, skipped };
}
