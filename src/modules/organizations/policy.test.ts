import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/policy";
import { STAFF_ROLES } from "@/modules/identity/roles";
import { MEMBER_ROLES, type MemberRole } from "./constants";
import { can, type OrganizationAction } from "./policy";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "u-1",
    emailVerified: true,
    roles: [],
    mfaSatisfied: false,
    ...overrides,
  };
}

const ACTIONS = [
  "organization.create",
  "organization.read",
  "organization.leave",
  "organization.update",
  "members.read",
  "invitations.read",
  "invitation.create",
  "invitation.revoke",
  "member.remove",
  "member.changeRole",
] as const satisfies readonly OrganizationAction[];

describe("can: fails closed", () => {
  it.each(ACTIONS)("denies %s without an actor", (action) => {
    expect(can(null, action, { actorRole: "owner" })).toBe(false);
    expect(can(undefined, action, { actorRole: "owner" })).toBe(false);
  });

  it.each(ACTIONS)("denies %s to an unverified email", (action) => {
    const unverified = actor({ emailVerified: false });
    expect(
      can(unverified, action, {
        actorRole: "owner",
        targetRole: "recruiter",
        targetIsSelf: false,
      }),
    ).toBe(false);
  });

  it.each(ACTIONS.filter((a) => a !== "organization.create"))(
    "denies %s to a non-member, even staff with MFA",
    (action) => {
      const staff = actor({ roles: STAFF_ROLES, mfaSatisfied: true });
      for (const resource of [
        undefined,
        {},
        { actorRole: null },
        { actorRole: "superuser" as MemberRole },
      ])
        expect(
          can(staff, action, {
            ...resource,
            targetRole: "recruiter",
            targetIsSelf: false,
          }),
        ).toBe(false);
    },
  );

  it("denies an unknown action", () => {
    expect(
      can(actor(), "organization.delete" as OrganizationAction, {
        actorRole: "owner",
      }),
    ).toBe(false);
  });
});

describe("can: the role matrix (ADR-005)", () => {
  it("lets any verified user create an organization", () => {
    expect(can(actor(), "organization.create")).toBe(true);
  });

  it.each(MEMBER_ROLES)("lets a %s read and leave", (role) => {
    expect(can(actor(), "organization.read", { actorRole: role })).toBe(true);
    expect(can(actor(), "organization.leave", { actorRole: role })).toBe(true);
  });

  it.each([
    ["owner", true],
    ["admin", true],
    ["recruiter", false],
  ] as const)("update, members and invitations for a %s: %s", (role, ok) => {
    for (const action of [
      "organization.update",
      "members.read",
      "invitations.read",
    ] as const)
      expect(can(actor(), action, { actorRole: role })).toBe(ok);
  });

  // [actor role, target role, may invite / revoke / remove]
  const MANAGE: [MemberRole, MemberRole, boolean][] = [
    ["owner", "owner", true],
    ["owner", "admin", true],
    ["owner", "recruiter", true],
    ["admin", "owner", false],
    ["admin", "admin", false],
    ["admin", "recruiter", true],
    ["recruiter", "owner", false],
    ["recruiter", "admin", false],
    ["recruiter", "recruiter", false],
  ];

  it.each(MANAGE)(
    "a %s acting on a %s: invite, revoke and remove %s",
    (actorRole, targetRole, ok) => {
      const r = { actorRole, targetRole, targetIsSelf: false };
      expect(can(actor(), "invitation.create", r)).toBe(ok);
      expect(can(actor(), "invitation.revoke", r)).toBe(ok);
      expect(can(actor(), "member.remove", r)).toBe(ok);
    },
  );

  it("needs a known target role for invitations and removals", () => {
    for (const action of [
      "invitation.create",
      "invitation.revoke",
      "member.remove",
    ] as const) {
      expect(can(actor(), action, { actorRole: "owner" })).toBe(false);
      expect(
        can(actor(), action, {
          actorRole: "owner",
          targetRole: "god" as MemberRole,
          targetIsSelf: false,
        }),
      ).toBe(false);
    }
  });

  it("never removes or re-roles oneself (leaving is separate)", () => {
    for (const action of ["member.remove", "member.changeRole"] as const) {
      expect(
        can(actor(), action, {
          actorRole: "owner",
          targetRole: "admin",
          targetIsSelf: true,
        }),
      ).toBe(false);
      // Unknown self-ness is treated as self.
      expect(
        can(actor(), action, { actorRole: "owner", targetRole: "admin" }),
      ).toBe(false);
    }
  });

  it.each([
    ["owner", true],
    ["admin", false],
    ["recruiter", false],
  ] as const)("changing another member's role as a %s: %s", (role, ok) => {
    for (const targetRole of MEMBER_ROLES)
      expect(
        can(actor(), "member.changeRole", {
          actorRole: role,
          targetRole,
          targetIsSelf: false,
        }),
      ).toBe(ok);
  });
});
