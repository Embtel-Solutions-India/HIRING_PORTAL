/** Resume objects in S3 (versioned bucket). Our own SHA-256 is stored as object metadata; ETags are never used as checksums. */
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.ts";

let client: S3Client | null = null;
const s3 = () =>
  (client ??= new S3Client({ region: config.s3.region, credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } }));
const Bucket = () => config.s3.bucket;

export const s3Configured = () => !!(config.s3.bucket && config.s3.region && config.s3.accessKeyId && config.s3.secretAccessKey);

export async function put(key: string, data: Buffer, mimeType: string, sha256: string): Promise<{ versionId: string }> {
  const res = await s3().send(new PutObjectCommand({ Bucket: Bucket(), Key: key, Body: data, ContentType: mimeType, Metadata: { sha256 } }));
  if (!res.VersionId) throw new Error("S3 bucket versioning is off — turn it on (see DEPLOY.md)");
  return { versionId: res.VersionId };
}

export async function get(key: string, versionId?: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key, VersionId: versionId }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function head(key: string, versionId?: string): Promise<{ size: number; sha256: string; versionId: string }> {
  const res = await s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key: key, VersionId: versionId }));
  return { size: res.ContentLength ?? -1, sha256: res.Metadata?.sha256 ?? "", versionId: res.VersionId ?? "" };
}

/** Server-side copy; metadata (incl. sha256) is copied with the object. */
export async function copy(fromKey: string, toKey: string): Promise<{ versionId: string }> {
  const source = `${Bucket()}/${fromKey.split("/").map(encodeURIComponent).join("/")}`;
  const res = await s3().send(new CopyObjectCommand({ Bucket: Bucket(), Key: toKey, CopySource: source }));
  if (!res.VersionId) throw new Error("S3 bucket versioning is off — turn it on (see DEPLOY.md)");
  return { versionId: res.VersionId };
}

/** On a versioned bucket this adds a delete marker; earlier versions stay until the lifecycle rule expires them. */
export async function remove(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: Bucket(), Key: key }));
}
