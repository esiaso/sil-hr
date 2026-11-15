import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnv } from '../../config/env';

/** Object storage port. The database keeps object keys and metadata, never public paths. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  signedGetUrl(key: string, ttlSeconds: number, fileName: string): Promise<string>;
  ready(): Promise<boolean>;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  /** Signs URLs against the endpoint browsers can reach (may differ inside Docker). */
  private readonly publicClient: S3Client;
  private readonly bucket: string;
  private bucketChecked = false;

  constructor() {
    const s = loadEnv().storage;
    const base = { region: s.region, forcePathStyle: s.forcePathStyle, credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey } };
    this.client = new S3Client({ ...base, endpoint: s.endpoint });
    this.publicClient = new S3Client({ ...base, endpoint: s.publicEndpoint });
    this.bucket = s.bucket;
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketChecked) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })).catch((e: { name?: string }) => {
        if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
      });
    }
    this.bucketChecked = true;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: undefined }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  signedGetUrl(key: string, ttlSeconds: number, fileName: string): Promise<string> {
    const disposition = `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_')}"`;
    return getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition }), { expiresIn: ttlSeconds });
  }

  async ready(): Promise<boolean> {
    try {
      await this.ensureBucket();
      return true;
    } catch {
      return false;
    }
  }
}

/** Virus-scan hook. Replace with a ClamAV (or other) adapter in production. */
export interface VirusScanner {
  scan(body: Buffer, fileName: string): Promise<'clean' | 'infected' | 'not_scanned'>;
}

export class NoopScanner implements VirusScanner {
  async scan(): Promise<'not_scanned'> {
    return 'not_scanned';
  }
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');
