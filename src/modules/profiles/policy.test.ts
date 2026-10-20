import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/policy";
import { STAFF_ROLES } from "@/modules/identity/roles";
import { can, canViewProfile, type ProfileAction } from "./policy";

const OWNER_ONLY = [
  "profile.update",
  "professionalDetails.read",
  "professionalDetails.update",
] as const satisfies readonly ProfileAction[];

const ALL = ["profile.read", ...OWNER_ONLY] as const;

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "u-1",
    emailVerified: true,
    roles: [],
    mfaSatisfied: false,
    ...overrides,
  };
}

const staff = actor({ userId: "u-9", roles: STAFF_ROLES, mfaSatisfied: true });

describe("can: no actor or no resource", () => {
  it.each(ALL)("denies %s", (action) => {
    const resource = { ownerId: "u-1", visibility: "members" as const };
    expect(can(null, action, resource)).toBe(false);
    expect(can(undefined, action, resource)).toBe(false);
    expect(can(actor(), action)).toBe(false);
    expect(can(actor(), action, { ownerId: "" })).toBe(false);
  });

  it.each(ALL)("denies %s to an unverified actor, even the owner", (action) => {
    const unverified = actor({ emailVerified: false });
    expect(
      can(unverified, action, { ownerId: "u-1", visibility: "members" }),
    ).toBe(false);
  });
});

describe("can: owner-only actions", () => {
  it.each(OWNER_ONLY)("%s only on the actor's own resource", (action) => {
    expect(can(actor(), action, { ownerId: "u-1" })).toBe(true);
    expect(can(actor(), action, { ownerId: "u-2" })).toBe(false);
    // Visibility never opens private or write actions to others.
    expect(
      can(actor(), action, { ownerId: "u-2", visibility: "members" }),
    ).toBe(false);
    // Staff roles do not widen access to other users' data.
    expect(can(staff, action, { ownerId: "u-1" })).toBe(false);
  });
});

describe("can: profile.read", () => {
  it("lets the owner read whatever the visibility", () => {
    for (const visibility of ["members", "hidden", undefined] as const) {
      expect(can(actor(), "profile.read", { ownerId: "u-1", visibility })).toBe(
        true,
      );
    }
  });

  it("lets other members read only `members` profiles", () => {
    expect(
      can(actor(), "profile.read", { ownerId: "u-2", visibility: "members" }),
    ).toBe(true);
    expect(
      can(actor(), "profile.read", { ownerId: "u-2", visibility: "hidden" }),
    ).toBe(false);
    expect(
      can(staff, "profile.read", { ownerId: "u-2", visibility: "hidden" }),
    ).toBe(false);
  });

  it("fails closed on a missing or unknown visibility", () => {
    expect(can(actor(), "profile.read", { ownerId: "u-2" })).toBe(false);
    expect(
      can(actor(), "profile.read", {
        ownerId: "u-2",
        visibility: "public" as never,
      }),
    ).toBe(false);
  });
});

describe("can: unknown actions fail closed", () => {
  it.each([
    "profile.delete",
    "profile.*",
    "toString",
    "__proto__",
    "constructor",
    "",
    "account.read",
  ])("denies %j even to the owner", (name) => {
    expect(
      can(actor(), name as ProfileAction, {
        ownerId: "u-1",
        visibility: "members",
      }),
    ).toBe(false);
  });
});

describe("canViewProfile", () => {
  const row = (userId: string, visibility: string) => ({ userId, visibility });

  it("applies the visibility rule to a loaded row", () => {
    expect(canViewProfile(actor(), row("u-1", "hidden"))).toBe(true);
    expect(canViewProfile(actor(), row("u-2", "members"))).toBe(true);
    expect(canViewProfile(actor(), row("u-2", "hidden"))).toBe(false);
    expect(canViewProfile(actor(), row("u-2", "unexpected"))).toBe(false);
    expect(canViewProfile(null, row("u-2", "members"))).toBe(false);
  });
});
