import { describe, expect, it } from "vitest";
import { auditIp, recordAudit } from "./audit";

// The audit writer (ADR-008): only codes reach the detail, only an IP
// address reaches the ip column.

function fakeDb() {
  const rows: unknown[] = [];
  const db = {
    insert: () => ({
      values: async (row: unknown) => void rows.push(row),
    }),
  } as unknown as Parameters<typeof recordAudit>[0];
  return { db, rows };
}

const base = {
  actorId: "00000000-0000-4000-8000-000000000001",
  actorKind: "staff",
  targetType: "user",
  targetId: "00000000-0000-4000-8000-000000000002",
} as const;

describe("auditIp", () => {
  it("keeps the first forwarded address when it is an IP", () => {
    expect(auditIp("203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
    expect(auditIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("drops anything else", () => {
    expect(auditIp(null)).toBeNull();
    expect(auditIp(undefined)).toBeNull();
    expect(auditIp("")).toBeNull();
    expect(auditIp("unknown, 203.0.113.9")).toBeNull();
    expect(auditIp("<script>")).toBeNull();
  });
});

describe("recordAudit", () => {
  it("writes the detail each action allows", async () => {
    const { db, rows } = fakeDb();
    await recordAudit(db, {
      ...base,
      action: "role.granted",
      detail: { role: "moderator" },
      ip: "203.0.113.9, 10.0.0.1",
    });
    expect(rows).toEqual([
      expect.objectContaining({
        action: "role.granted",
        detail: { role: "moderator" },
        ip: "203.0.113.9",
      }),
    ]);
  });

  it("refuses extra fields, free text and missing fields", async () => {
    const { db, rows } = fakeDb();
    await expect(
      recordAudit(db, {
        ...base,
        action: "role.granted",
        detail: { role: "moderator", email: "a@example.test" },
      }),
    ).rejects.toThrow();
    await expect(
      recordAudit(db, {
        ...base,
        action: "job.moderated",
        detail: { decision: "rejected", reasonCode: "a note with spaces" },
      }),
    ).rejects.toThrow();
    await expect(
      recordAudit(db, {
        ...base,
        action: "verification.decided",
        detail: { decision: "verified" },
      }),
    ).rejects.toThrow();
    await expect(
      recordAudit(db, {
        ...base,
        action: "account.data_exported",
        detail: { anything: "x" },
      }),
    ).rejects.toThrow();
    expect(rows).toEqual([]);
  });
});
