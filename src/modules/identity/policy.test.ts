import { describe, expect, it } from "vitest";
import {
  type Action,
  type Actor,
  actorFromSession,
  can,
  ROLE_ACTION,
} from "./policy";
import { STAFF_ROLES, type StaffRole } from "./roles";

const STAFF_ACTIONS = [
  "staff.access",
  "support.access",
  "moderation.access",
  "verification.review",
  "billing.access",
  "roles.manage",
] as const satisfies readonly Action[];

const ACCOUNT_ACTIONS = [
  "account.read",
  "account.manage",
] as const satisfies readonly Action[];

// The only role that grants each duty action (staff.access: any role).
const EXPECTED_ROLE: Record<(typeof STAFF_ACTIONS)[number], StaffRole | "any"> =
  {
    "staff.access": "any",
    "support.access": "support",
    "moderation.access": "moderator",
    "verification.review": "verification_reviewer",
    "billing.access": "billing",
    "roles.manage": "super_admin",
  };

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "u-1",
    emailVerified: true,
    roles: [],
    mfaSatisfied: false,
    ...overrides,
  };
}

describe("can: no actor", () => {
  it.each([...STAFF_ACTIONS, ...ACCOUNT_ACTIONS])("denies %s", (action) => {
    expect(can(null, action, { ownerId: "u-1" })).toBe(false);
    expect(can(undefined, action, { ownerId: "u-1" })).toBe(false);
  });
});

describe("can: own account", () => {
  it.each(ACCOUNT_ACTIONS)("%s only on the actor's own resource", (action) => {
    expect(can(actor(), action, { ownerId: "u-1" })).toBe(true);
    expect(can(actor(), action, { ownerId: "u-2" })).toBe(false);
    expect(can(actor(), action)).toBe(false);
    // Roles and MFA do not widen account access to other users.
    expect(
      can(actor({ roles: STAFF_ROLES, mfaSatisfied: true }), action, {
        ownerId: "u-2",
      }),
    ).toBe(false);
  });
});

describe("can: staff actions, every combination", () => {
  const roleSets: StaffRole[][] = [
    [],
    ...STAFF_ROLES.map((r) => [r]),
    [...STAFF_ROLES],
  ];
  for (const action of STAFF_ACTIONS) {
    for (const roles of roleSets) {
      for (const mfaSatisfied of [false, true]) {
        for (const emailVerified of [false, true]) {
          const expectedRole = EXPECTED_ROLE[action];
          const hasRole =
            expectedRole === "any"
              ? roles.length > 0
              : roles.includes(expectedRole);
          const expected = hasRole && mfaSatisfied && emailVerified;
          it(`${action} roles=[${roles.join(",")}] mfa=${mfaSatisfied} verified=${emailVerified} → ${expected}`, () => {
            expect(
              can(actor({ roles, mfaSatisfied, emailVerified }), action),
            ).toBe(expected);
          });
        }
      }
    }
  }
});

describe("can: separation of duties", () => {
  it("super_admin is not a superset of the other duties", () => {
    const admin = actor({ roles: ["super_admin"], mfaSatisfied: true });
    expect(can(admin, "roles.manage")).toBe(true);
    expect(can(admin, "verification.review")).toBe(false);
    expect(can(admin, "billing.access")).toBe(false);
  });

  it("maps every role to an action that role grants", () => {
    for (const role of STAFF_ROLES) {
      expect(
        can(actor({ roles: [role], mfaSatisfied: true }), ROLE_ACTION[role]),
      ).toBe(true);
    }
  });
});

describe("can: unknown actions fail closed", () => {
  it.each(["admin", "toString", "__proto__", "constructor", "", "staff.*"])(
    "denies %j even for a fully privileged actor",
    (name) => {
      const all = actor({ roles: STAFF_ROLES, mfaSatisfied: true });
      expect(can(all, name as Action, { ownerId: "u-1" })).toBe(false);
    },
  );
});

describe("actorFromSession", () => {
  const base = {
    user: { id: "u-1", emailVerified: true, twoFactorEnabled: true },
  };

  it("requires TOTP enabled and an MFA-verified session", () => {
    expect(
      actorFromSession({ ...base, session: { mfaVerifiedAt: new Date() } }, [])
        .mfaSatisfied,
    ).toBe(true);
    expect(
      actorFromSession({ ...base, session: { mfaVerifiedAt: null } }, [])
        .mfaSatisfied,
    ).toBe(false);
    expect(
      actorFromSession(
        {
          user: { ...base.user, twoFactorEnabled: false },
          session: { mfaVerifiedAt: new Date() },
        },
        [],
      ).mfaSatisfied,
    ).toBe(false);
  });
});
