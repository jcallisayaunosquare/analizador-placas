/**
 * The remaining adapters: S3 HeadObject and the DynamoDB event publisher.
 *
 * Both are thin on purpose. The interesting code is in `domain/`, and that is the
 * point: the part worth testing has no AWS in it.
 */

import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import type {
  CaptureMetadata,
  CaptureStorage,
  EventPublisher,
  PlateRecognizedEvent,
} from '../ports.js';

export class S3CaptureStorage implements CaptureStorage {
  constructor(private readonly client: S3Client) {}

  async head(bucket: string, key: string): Promise<CaptureMetadata> {
    const r = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const meta = r.Metadata ?? {};

    // S3 lowercases user metadata keys, always. Reading `x-amz-meta-Camera-Id` back as
    // `Camera-Id` returns undefined and the event silently loses its camera.
    return {
      // No metadata means the object was not uploaded through POST /captures. The key
      // is the fallback identity so the frame is still processed rather than dropped.
      captureId: meta['capture-id'] ?? captureIdFromKey(key),
      cameraId: meta['camera-id'] ?? cameraIdFromKey(key),
      capturedAt: meta['captured-at'] ?? (r.LastModified ?? new Date()).toISOString(),
      sizeBytes: r.ContentLength ?? 0,
      contentType: r.ContentType ?? null,
    };
  }
}

/** `raw/<cameraId>/<yyyy>/<mm>/<dd>/<captureId>.jpg` */
export const captureIdFromKey = (key: string): string =>
  (key.split('/').pop() ?? key).replace(/\.[a-z0-9]+$/i, '');

export const cameraIdFromKey = (key: string): string => key.split('/')[1] ?? 'unknown';

export class DynamoEventPublisher implements EventPublisher {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private pk(captureId: string): string {
    return `plateread#${captureId}`;
  }

  async alreadyPublished(captureId: string): Promise<boolean> {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.pk(captureId) },
        ProjectionExpression: 'pk',
        // Strongly consistent: the whole point is to not pay for a second Rekognition
        // call, and an eventually consistent read can miss the first one.
        ConsistentRead: true,
      }),
    );
    return r.Item !== undefined;
  }

  async publishIfAbsent(event: PlateRecognizedEvent, ttlSeconds: number): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: this.pk(event.captureId),
            type: 'PlateRecognized',
            ...event,
            expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
          },
          // The real idempotency guard. The GetItem above is an optimisation that
          // saves a Rekognition call; THIS is what makes a retry a no-op.
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}

/** Structured JSON lines, the shape Powertools emits, without the dependency. */
export const consoleLogger = (service: string) => ({
  info: (message: string, context?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'INFO', service, message, ...context })),
  warn: (message: string, context?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'WARN', service, message, ...context })),
  error: (message: string, context?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'ERROR', service, message, ...context })),
});
