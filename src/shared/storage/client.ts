import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "@/shared/config/env";

const globalForS3 = globalThis as unknown as { __s3?: S3Client };

export function getS3(): S3Client {
  if (!globalForS3.__s3) {
    const env = getEnv();
    globalForS3.__s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: true, // required by MinIO and most S3-compatible providers
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return globalForS3.__s3;
}

/** Throws if the private bucket is unreachable or missing. */
export async function checkPrivateBucket(): Promise<void> {
  await getS3().send(
    new HeadBucketCommand({ Bucket: getEnv().S3_PRIVATE_BUCKET }),
  );
}
