import { randomBytes } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { ping } from "@/shared/av/clamd";

// Real MinIO and clamd for the upload integration tests, started with
// Testcontainers like the Postgres harness. Same images as docker-compose.yml.

export const MINIO_IMAGE = "bitnamilegacy/minio:2025.7.23-debian-12-r5";
export const CLAMAV_IMAGE = "clamav/clamav:1.5.4";

export type ObjectStorage = Awaited<ReturnType<typeof startObjectStorage>>;

async function retry<T>(fn: () => Promise<T>, attempts = 20, delayMs = 500) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function startObjectStorage(bucket = "pharma-private") {
  // Generated per run so no credential-shaped literal lives in the repo.
  const accessKeyId = `test${randomBytes(6).toString("hex")}`;
  const secretAccessKey = randomBytes(24).toString("base64url");
  const container: StartedTestContainer = await new GenericContainer(
    MINIO_IMAGE,
  )
    .withEnvironment({
      MINIO_ROOT_USER: accessKeyId,
      MINIO_ROOT_PASSWORD: secretAccessKey,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
    .withStartupTimeout(120_000)
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  // MinIO can restart once during first-start setup; retry until it answers.
  await retry(() => s3.send(new CreateBucketCommand({ Bucket: bucket })));
  return {
    s3,
    bucket,
    endpoint,
    async stop() {
      s3.destroy();
      await container.stop();
    },
  };
}

export type Clamd = Awaited<ReturnType<typeof startClamd>>;

/**
 * clamd with the signature snapshot baked into the image and updates off, so
 * start-up needs no network. Loading signatures takes about 20-60 s and
 * about 1-1.5 GB of memory.
 */
export async function startClamd() {
  const container = await new GenericContainer(CLAMAV_IMAGE)
    .withEnvironment({ CLAMAV_NO_FRESHCLAMD: "true" })
    .withExposedPorts(3310)
    .withWaitStrategy(Wait.forLogMessage("socket found, clamd started."))
    .withStartupTimeout(300_000)
    .start();
  const config = {
    host: container.getHost(),
    port: container.getMappedPort(3310),
  };
  await retry(async () => {
    if (!(await ping(config))) throw new Error("clamd not answering");
  }, 60);
  return { config, stop: () => container.stop() };
}

/**
 * The EICAR antivirus test file, assembled at runtime so no file in the
 * repository is itself detected by scanners. It is harmless by design.
 */
export function eicar(): Uint8Array {
  const head = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$";
  const tail = ["EICAR", "STANDARD", "ANTIVIRUS", "TEST", "FILE!$H+H*"].join(
    "-",
  );
  return new TextEncoder().encode(head + tail);
}
