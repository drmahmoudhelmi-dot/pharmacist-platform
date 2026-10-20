export const dynamic = "force-dynamic";

// Liveness: no dependencies, so a dependency outage never restarts the process.
export function GET() {
  return Response.json({ status: "ok" });
}
