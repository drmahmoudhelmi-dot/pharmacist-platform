import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/policy";
import { STAFF_ROLES } from "@/modules/identity/roles";
import { can, type UploadAction } from "./policy";

const ALL = [
  "upload.create",
  "upload.readStatus",
  "upload.view",
] as const satisfies readonly UploadAction[];

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "u-1",
    emailVerified: true,
    roles: [],
    mfaSatisfied: false,
    ...overrides,
  };
}

describe("uploads can()", () => {
  it.each(ALL)("allows the owner to %s", (action) => {
    expect(can(actor(), action, { ownerId: "u-1" })).toBe(true);
  });

  it.each(ALL)("denies %s to another user", (action) => {
    expect(can(actor({ userId: "u-2" }), action, { ownerId: "u-1" })).toBe(
      false,
    );
  });

  it.each(ALL)("denies %s without an actor or resource", (action) => {
    expect(can(null, action, { ownerId: "u-1" })).toBe(false);
    expect(can(undefined, action, { ownerId: "u-1" })).toBe(false);
    expect(can(actor(), action)).toBe(false);
    expect(can(actor(), action, { ownerId: "" })).toBe(false);
  });

  it.each(ALL)("denies %s to an owner whose email is unverified", (action) => {
    expect(
      can(actor({ emailVerified: false }), action, { ownerId: "u-1" }),
    ).toBe(false);
  });

  it.each(ALL)("does not widen %s for staff, even with MFA", (action) => {
    const staff = actor({
      userId: "u-9",
      roles: STAFF_ROLES,
      mfaSatisfied: true,
    });
    expect(can(staff, action, { ownerId: "u-1" })).toBe(false);
  });

  it("denies unknown actions", () => {
    expect(
      can(actor(), "upload.delete" as UploadAction, { ownerId: "u-1" }),
    ).toBe(false);
  });
});
