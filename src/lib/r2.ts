import crypto from 'node:crypto';
import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { env } from '../config/env.js';

export type MediaKind = 'avatar' | 'banner';

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

const MIME_TO_EXTENSION: Record<AcceptedImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

let s3ClientInstance: S3Client | null = null;

export function getS3Client(): S3Client {
  if (s3ClientInstance) {
    return s3ClientInstance;
  }

  const isProd = env.NODE_ENV === 'production';

  s3ClientInstance = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    // MinIO in local dev/test requires path style; Cloudflare R2 uses virtual-hosted style in production
    forcePathStyle: !isProd,
  });

  return s3ClientInstance;
}

export function generateObjectKey(userId: string, kind: MediaKind, contentType: AcceptedImageType): string {
  const ext = MIME_TO_EXTENSION[contentType] || 'jpg';
  const uuid = crypto.randomUUID();
  return `users/${userId}/${kind}/${uuid}.${ext}`;
}

export function isValidUserKey(userId: string, kind: MediaKind, objectKey: string): boolean {
  const expectedPrefix = `users/${userId}/${kind}/`;
  return objectKey.startsWith(expectedPrefix);
}

export interface PresignedUploadSlot {
  uploadUrl: string;
  fields: Record<string, string>;
  objectKey: string;
  expiresAt: string;
  maxBytes: number;
}

/**
 * Creates an S3 presigned POST upload slot with strict policy limits
 */
export async function createPresignedUpload(
  userId: string,
  kind: MediaKind,
  contentType: AcceptedImageType,
  contentLength: number
): Promise<PresignedUploadSlot> {
  const s3 = getS3Client();
  const maxBytes = kind === 'avatar' ? env.MAX_AVATAR_BYTES : env.MAX_BANNER_BYTES;

  const objectKey = generateObjectKey(userId, kind, contentType);
  const expiresInSeconds = 300; // 5 minutes

  const presignedPost: PresignedPost = await createPresignedPost(s3, {
    Bucket: env.R2_BUCKET,
    Key: objectKey,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
      ['eq', '$key', objectKey],
      ['eq', '$success_action_status', '204'],
    ],
    Fields: {
      'Content-Type': contentType,
      key: objectKey,
      success_action_status: '204',
    },
    Expires: expiresInSeconds,
  });

  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  return {
    uploadUrl: presignedPost.url,
    fields: presignedPost.fields,
    objectKey,
    expiresAt,
    maxBytes,
  };
}

export interface ObjectMetadata {
  contentLength: number;
  contentType: string;
  lastModified?: Date;
}

/**
 * Checks if object exists in R2/S3 storage and returns its metadata
 */
export async function headObject(objectKey: string): Promise<ObjectMetadata | null> {
  const s3 = getS3Client();
  try {
    const res: HeadObjectCommandOutput = await s3.send(
      new HeadObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: objectKey,
      })
    );

    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
      lastModified: res.LastModified,
    };
  } catch (err: any) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Deletes object from R2/S3 storage (best effort)
 */
export async function deleteObject(objectKey: string): Promise<void> {
  const s3 = getS3Client();
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: objectKey,
      })
    );
  } catch (err: any) {
    console.warn(`[R2] Warning: failed to delete object '${objectKey}':`, err.message);
  }
}

/**
 * Computes public CDN URL from R2 object key
 */
export function computePublicUrl(objectKey: string | null | undefined, updatedAt?: Date): string | null {
  if (!objectKey) {
    return null;
  }

  const baseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
  const versionParam = updatedAt ? `?v=${updatedAt.getTime()}` : '';
  return `${baseUrl}/${objectKey}${versionParam}`;
}
