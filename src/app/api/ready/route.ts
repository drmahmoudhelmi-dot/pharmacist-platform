import { getPool } from "@/shared/db/client";
import { logger } from "@/shared/logging/logger";
import { checkPrivateBucket } from "@/shared/storage/client";

export const dynamic = "force-dynamic";

async function probe(
  name: "db" | "storage",
  fn: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    // Details stay in server logs; the response carries booleans only.
    logger.error({ err: error, check: name }, "readiness check failed");
    return false;
  }
}

// Readiness: reports whether dependencies are reachable.
export async function GET() {
  const [db, storage] = await Promise.all([
    probe("db", () => getPool().query("select 1")),
    probe("storage", checkPrivateBucket),
  ]);
  const ready = db && storage;
  return Response.json(
    { status: ready ? "ok" : "unavailable", checks: { db, storage } },
    { status: ready ? 200 : 503 },
  );
}
