// Worker health check: `pnpm worker:health [--this-host]`. Exits 0 when at
// least one live worker (it refreshed its pg-boss registry row within three
// heartbeats, 30 s) is serving the upload queue, 1 otherwise. With
// `--this-host`, only a worker on this machine counts, for use as the worker
// container's health check. Prints counts only.
import { hostname } from "node:os";
import { createAdminBoss } from "@/shared/jobs/boss";
import { createLogger } from "@/shared/logging/logger";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (copy .env.example to .env).");
    return 2;
  }
  const thisHost = process.argv.includes("--this-host");
  const boss = createAdminBoss(
    url,
    createLogger({ base: { tool: "worker-health" } }),
  );
  await boss.start();
  try {
    const live = (await boss.getInstances()).filter(
      (instance) =>
        instance.name === "worker" &&
        instance.live &&
        instance.workers.some((w) => w.queue === "upload.process") &&
        (!thisHost || instance.host === hostname()),
    );
    console.log(JSON.stringify({ liveWorkers: live.length }));
    return live.length > 0 ? 0 : 1;
  } finally {
    await boss.stop({ graceful: false });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      "Health check failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exit(1);
  });
