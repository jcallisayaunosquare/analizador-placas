/**
 * Local end-to-end driver, in two modes.
 *
 *   --offline   fake recognizer, fake S3, in-memory event table. No AWS, no credentials.
 *               Runs the full use case over scripted frames and FAILS the process if any
 *               of them stops producing its expected decision, so it doubles as an
 *               integration test of the wiring.
 *
 *   (default)   real Rekognition DetectText against a real S3 object, with the publisher
 *               still faked so nothing is written to pacs-events. This is the call worth
 *               making BEFORE building any infrastructure: it answers whether Rekognition
 *               can read the plates of THIS building's cameras.
 *
 * Usage:
 *   pnpm offline
 *   pnpm live -- --bucket pacs-captures-dev --key raw/gate-north/2026/10/09/TEST01.jpg
 *   pnpm live -- --file ./plate.jpg --bucket pacs-captures-dev     # uploads, then reads
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

import { recognizeCapture, type RecognizeCaptureDeps } from '../src/recognize-capture.js';
import { decide, DEFAULT_THRESHOLDS, type RegisteredVehicle } from '../src/domain/decision.js';
import { DEFAULT_BLOCKLIST } from '../src/domain/bolivian-format.js';
import { normalizePlate } from '../src/domain/plate.js';
import type {
  CaptureMetadata,
  CaptureStorage,
  EventPublisher,
  PlateRecognizedEvent,
  PlateRecognizer,
  RecognitionResult,
} from '../src/ports.js';

const { values } = parseArgs({
  options: {
    offline: { type: 'boolean', default: false },
    bucket: { type: 'string' },
    key: { type: 'string' },
    file: { type: 'string' },
    region: { type: 'string', default: 'us-east-2' },
    profile: { type: 'string' },
  },
  allowPositionals: false,
});

// ---------------------------------------------------------------- fake register

/** Stands in for the resident vehicle register, so a decision can be shown. */
const REGISTER: readonly RegisteredVehicle[] = [
  { vehicleId: 'v-1', residentId: 'r-ana', plate: normalizePlate('1234ABC'), isActive: true, residentIsEligible: true },
  { vehicleId: 'v-2', residentId: 'r-luis', plate: normalizePlate('567DEF'), isActive: true, residentIsEligible: true },
  { vehicleId: 'v-3', residentId: 'r-mara', plate: normalizePlate('O987XYZ'), isActive: true, residentIsEligible: false },
];

// ---------------------------------------------------------------- fake adapters

class FakeStorage implements CaptureStorage {
  constructor(private readonly meta: Partial<CaptureMetadata> = {}) {}
  async head(_bucket: string, key: string): Promise<CaptureMetadata> {
    return {
      captureId: this.meta.captureId ?? (key.split('/').pop() ?? key).replace(/\.\w+$/, ''),
      cameraId: this.meta.cameraId ?? 'gate-north',
      capturedAt: this.meta.capturedAt ?? new Date().toISOString(),
      sizeBytes: this.meta.sizeBytes ?? 180_000,
      contentType: this.meta.contentType ?? 'image/jpeg',
    };
  }
}

class MemoryPublisher implements EventPublisher {
  readonly events = new Map<string, PlateRecognizedEvent>();
  async alreadyPublished(captureId: string): Promise<boolean> {
    return this.events.has(captureId);
  }
  async publishIfAbsent(event: PlateRecognizedEvent): Promise<boolean> {
    if (this.events.has(event.captureId)) return false;
    this.events.set(event.captureId, event);
    return true;
  }
}

interface Scenario {
  readonly name: string;
  /** The decision reason this frame must produce. */
  readonly expect: string;
  readonly result: RecognitionResult;
}

/** Scripted frames: what a gate camera actually sends over a day. */
const SCENARIOS: readonly Scenario[] = [
  {
    name: 'clean plate, broad daylight',
    expect: 'EXACT_MATCH',
    result: {
      candidates: [
        { text: '1234 ABC', confidence: 0.972, box: { left: 0.4, top: 0.62, width: 0.14, height: 0.042 } },
        { text: 'BOLIVIA', confidence: 0.88, box: { left: 0.41, top: 0.6, width: 0.1, height: 0.012 } },
      ],
      quality: 0.82,
      engine: 'fake',
      engineVersion: 'offline',
      latencyMs: 410,
    },
  },
  {
    // The B/8 pair is not folded canonically, so the fuzzy tier is what recovers this.
    name: 'B read as 8, the fuzzy tier earning its keep',
    expect: 'LOW_CONFIDENCE',
    result: {
      candidates: [{ text: '1234 A8C', confidence: 0.903, box: { left: 0.4, top: 0.62, width: 0.14, height: 0.038 } }],
      quality: 0.74,
      engine: 'fake',
      engineVersion: 'offline',
      latencyMs: 398,
    },
  },
  {
    // The case that caught a real bug: VISITAS canonicalises to V1S1TAS, and the U/V
    // pair would expand that to U1S1TAS, which the blocklist had never heard of.
    name: 'signage only, no vehicle in frame',
    expect: 'UNREADABLE',
    result: {
      candidates: [
        { text: 'PARQUEO PRIVADO', confidence: 0.991, box: { left: 0.1, top: 0.1, width: 0.6, height: 0.08 } },
        { text: 'VISITAS', confidence: 0.962, box: { left: 0.1, top: 0.2, width: 0.2, height: 0.04 } },
      ],
      quality: 0.6,
      engine: 'fake',
      engineVersion: 'offline',
      latencyMs: 355,
    },
  },
  {
    // Read correctly, but far too few pixels to act on. No access event at all.
    name: 'dusk, plate small in frame',
    expect: 'UNREADABLE',
    result: {
      candidates: [{ text: '1234ABC', confidence: 0.61, box: { left: 0.45, top: 0.7, width: 0.05, height: 0.014 } }],
      quality: 0.18,
      engine: 'fake',
      engineVersion: 'offline',
      latencyMs: 402,
    },
  },
  {
    name: 'unregistered visitor, read perfectly',
    expect: 'PLATE_NOT_REGISTERED',
    result: {
      candidates: [{ text: '9876 ZYX', confidence: 0.981, box: { left: 0.4, top: 0.62, width: 0.14, height: 0.044 } }],
      quality: 0.88,
      engine: 'fake',
      engineVersion: 'offline',
      latencyMs: 377,
    },
  },
  {
    name: 'registered but the resident is not eligible',
    expect: 'RESIDENT_NOT_ELIGIBLE',
    result: {
      candidates: [{ text: '0987 XYZ', confidence: 0.975, box: { left: 0.4, top: 0.62, width: 0.14, height: 0.043 } }],
      quality: 0.85,
      engine: 'fake',
      engineVersion: 'offline',
      latencyMs: 381,
    },
  },
  {
    name: 'nothing readable at all',
    expect: 'UNREADABLE',
    result: { candidates: [], quality: null, engine: 'fake', engineVersion: 'offline', latencyMs: 340 },
  },
];

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: (m: string, c?: Record<string, unknown>) => console.error('ERROR', m, c),
};

const baseConfig = {
  maxBytes: 8 * 1024 * 1024,
  cooldownSeconds: 30,
  eventTtlSeconds: 14 * 24 * 3600,
  blocklist: DEFAULT_BLOCKLIST,
  thresholds: DEFAULT_THRESHOLDS,
};

interface EventCandidate {
  readonly plate: string;
  readonly score: number;
}

async function runOffline(): Promise<void> {
  console.log('\n  PACS plates - offline pipeline run (no AWS)\n');
  const publisher = new MemoryPublisher();
  let failures = 0;

  for (const [i, scenario] of SCENARIOS.entries()) {
    const captureId = `CAP${String(i).padStart(3, '0')}`;
    const recognizer: PlateRecognizer = { recognize: async () => scenario.result };
    const deps: RecognizeCaptureDeps = {
      storage: new FakeStorage({ captureId }),
      recognizer,
      publisher,
      logger: silentLogger,
      config: baseConfig,
    };

    const outcome = await recognizeCapture(deps, {
      bucket: 'local',
      key: `raw/gate-north/2026/10/09/${captureId}.jpg`,
    });

    const event = publisher.events.get(captureId);
    const candidates = (event?.candidates ?? []) as readonly EventCandidate[];
    const best = candidates[0] ?? null;

    // The real decision, with the register loaded: what plateIngest computes in-VPC.
    const decision = decide({
      best:
        best === null
          ? null
          : { plate: best.plate, raw: '', confidence: event?.best?.confidence ?? 0, score: best.score },
      quality: event?.quality ?? null,
      registered: REGISTER,
      withinCooldown: false,
    });

    const pass = decision.reason === scenario.expect;
    if (!pass) failures += 1;

    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${String(i + 1).padStart(2)}. ${scenario.name}`);
    console.log(`         outcome    ${outcome.kind}${outcome.kind === 'skipped' ? ` (${outcome.reason})` : ''}`);
    console.log(`         plate      ${decision.plate ?? '-'}`);
    console.log(`         fused      ${decision.fused.toFixed(3)}`);
    console.log(`         decision   ${decision.decision ?? 'no event'}  .  ${decision.reason}`);
    if (decision.ambiguousWith.length > 0) {
      console.log(`         ambiguous  ${decision.ambiguousWith.join(', ')}`);
    }
    if (!pass) console.log(`         EXPECTED   ${scenario.expect}`);
    console.log('');
  }

  // Idempotency, demonstrated rather than asserted in prose.
  const deps: RecognizeCaptureDeps = {
    storage: new FakeStorage({ captureId: 'CAP000' }),
    recognizer: { recognize: async () => SCENARIOS[0]!.result },
    publisher,
    logger: silentLogger,
    config: baseConfig,
  };
  const replay = await recognizeCapture(deps, { bucket: 'local', key: 'raw/x/CAP000.jpg' });
  const replaySkipped = replay.kind === 'skipped' && replay.reason === 'ALREADY_PROCESSED';
  console.log(`  ${replaySkipped ? 'PASS' : 'FAIL'}  replay of CAP000 -> ${replay.kind}`);
  console.log(`        events stored: ${publisher.events.size} (7 frames, 1 replay, no duplicate)\n`);
  if (!replaySkipped) failures += 1;

  console.log(`  ${SCENARIOS.length + 1 - failures}/${SCENARIOS.length + 1} checks passed\n`);
  if (failures > 0) process.exitCode = 1;
}

async function runLive(): Promise<void> {
  const bucket = values.bucket;
  if (bucket === undefined) {
    console.error('--bucket is required in live mode');
    process.exitCode = 1;
    return;
  }
  if (values.profile !== undefined) process.env['AWS_PROFILE'] = values.profile;
  process.env['AWS_REGION'] = values.region ?? 'us-east-2';

  // Imported here so offline mode needs no credentials.
  const { RekognitionClient } = await import('@aws-sdk/client-rekognition');
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { RekognitionPlateRecognizer } = await import('../src/infrastructure/rekognition-recognizer.js');
  const { S3CaptureStorage } = await import('../src/infrastructure/aws-adapters.js');

  const s3 = new S3Client({ region: values.region });
  let key = values.key;

  if (values.file !== undefined) {
    const captureId = Date.now().toString(36).toUpperCase();
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    key = `raw/gate-local/${yyyy}/${mm}/${dd}/${captureId}.jpg`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: await readFile(values.file),
        ContentType: 'image/jpeg',
        Metadata: { 'capture-id': captureId, 'camera-id': 'gate-local', 'captured-at': d.toISOString() },
      }),
    );
    console.log(`uploaded s3://${bucket}/${key}`);
  }

  if (key === undefined) {
    console.error('--key or --file is required in live mode');
    process.exitCode = 1;
    return;
  }

  const publisher = new MemoryPublisher();
  const deps: RecognizeCaptureDeps = {
    storage: new S3CaptureStorage(s3),
    recognizer: new RekognitionPlateRecognizer(new RekognitionClient({ region: values.region }), {
      minTextConfidence: 70,
    }),
    publisher,
    logger: {
      info: (m, c) => console.log(JSON.stringify({ level: 'INFO', message: m, ...c })),
      warn: (m, c) => console.warn(JSON.stringify({ level: 'WARN', message: m, ...c })),
      error: (m, c) => console.error(JSON.stringify({ level: 'ERROR', message: m, ...c })),
    },
    config: baseConfig,
  };

  const outcome = await recognizeCapture(deps, { bucket, key });
  console.log('\noutcome:', JSON.stringify(outcome, null, 2));

  const event = [...publisher.events.values()][0];
  if (event !== undefined) {
    const best = (event.candidates as readonly EventCandidate[])[0] ?? null;
    const decision = decide({
      best:
        best === null
          ? null
          : { plate: best.plate, raw: '', confidence: event.best?.confidence ?? 0, score: best.score },
      quality: event.quality,
      registered: REGISTER,
      withinCooldown: false,
    });
    console.log('\ndecision against the demo register:', JSON.stringify(decision, null, 2));
  }
}

await (values.offline ? runOffline() : runLive());
