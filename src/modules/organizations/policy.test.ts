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

describe("can: the role matrix (ADR-005, amended: owner and recruiter)", () => {
  it("lets any verified user create an organization", () => {
    expect(can(actor(), "organization.create")).toBe(true);
  });

  it.each(MEMBER_ROLES)("lets a %s read, leave and manage jobs", (role) => {
    for (const action of [
      "organization.read",
      "organization.leave",
      "jobs.manage",
    ] as const)
      expect(can(actor(), action, { actorRole: role })).toBe(true);
  });

  it.each([
    ["owner", true],
    ["recruiter", false],
  ] as const)("update, members and invitations for a %s: %s", (role, ok) => {
    for (const action of [
      "organization.update",
      "members.read",
      "invitations.read",
    ] as const)
      expect(can(actor(), action, { actorRole: role })).toBe(ok);
  });

  // [actor role, target role, may invite / revoke / remove / change role]
  const MANAGE: [MemberRole, MemberRole, boolean][] = [
    ["owner", "owner", true],
    ["owner", "recruiter", true],
    ["recruiter", "owner", false],
    ["recruiter", "recruiter", false],
  ];

  it.each(MANAGE)(
    "a %s acting on a %s: invite, revoke, remove and re-role %s",
    (actorRole, targetRole, ok) => {
      const r = { actorRole, targetRole, targetIsSelf: false };
      expect(can(actor(), "invitation.create", r)).toBe(ok);
      expect(can(actor(), "invitation.revoke", r)).toBe(ok);
      expect(can(actor(), "member.remove", r)).toBe(ok);
      expect(can(actor(), "member.changeRole", r)).toBe(ok);
    },
  );

  it("refuses the removed admin role and unknown roles", () => {
    for (const role of ["admin", "god"] as unknown as MemberRole[]) {
      expect(can(actor(), "organization.read", { actorRole: role })).toBe(
        false,
      );
      expect(
        can(actor(), "invitation.create", {
          actorRole: "owner",
          targetRole: role,
        }),
      ).toBe(false);
    }
  });

  it("needs a known target role for invitations and removals", () => {
    for (const action of [
      "invitation.create",
      "invitation.revoke",
      "member.remove",
      "member.changeRole",
    ] as const)
      expect(
        can(actor(), action, { actorRole: "owner", targetIsSelf: false }),
      ).toBe(false);
  });

  it("never removes or re-roles oneself (leaving is separate)", () => {
    for (const action of ["member.remove", "member.changeRole"] as const) {
      expect(
        can(actor(), action, {
          actorRole: "owner",
          targetRole: "recruiter",
          targetIsSelf: true,
        }),
      ).toBe(false);
      // Unknown self-ness is treated as self.
      expect(
        can(actor(), action, { actorRole: "owner", targetRole: "recruiter" }),
      ).toBe(false);
    }
  });
});
