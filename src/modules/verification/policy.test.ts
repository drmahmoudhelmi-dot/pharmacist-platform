import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/policy";
import { SUBMISSION_STATUSES } from "./constants";
import { can, type VerificationAction } from "./policy";

const user = (over: Partial<Actor> = {}): Actor => ({
  userId: "11111111-1111-4111-8111-111111111111",
  emailVerified: true,
  roles: [],
  mfaSatisfied: false,
  ...over,
});
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const reviewer = (over: Partial<Actor> = {}) =>
  user({
    userId: OTHER,
    roles: ["verification_reviewer"],
    mfaSatisfied: true,
    ...over,
  });

const REVIEW_ACTIONS: VerificationAction[] = [
  "verification.viewDocument",
  "verification.revealNationalId",
  "verification.decide",
];

describe("verification policy: owners", () => {
  it("lets a verified user submit and read their own status only", () => {
    for (const action of [
      "verification.submit",
      "verification.readOwn",
    ] as const) {
      expect(can(user(), action, { ownerId: OWNER })).toBe(true);
      expect(can(user(), action, { ownerId: OTHER })).toBe(false);
      expect(
        can(user({ emailVerified: false }), action, { ownerId: OWNER }),
      ).toBe(false);
      // A reviewer gains nothing over other users' own-data actions.
      expect(can(reviewer(), action, { ownerId: OWNER })).toBe(false);
    }
  });

  it("gives owners none of the reviewer actions on their own submission", () => {
    for (const action of [
      "verification.queue",
      "verification.read",
      ...REVIEW_ACTIONS,
    ] as const)
      expect(can(user(), action, { ownerId: OWNER, status: "pending" })).toBe(
        false,
      );
  });
});

describe("verification policy: reviewers", () => {
  it("needs the verification_reviewer role, MFA and a verified email", () => {
    expect(can(reviewer(), "verification.queue")).toBe(true);
    expect(can(reviewer({ mfaSatisfied: false }), "verification.queue")).toBe(
      false,
    );
    expect(can(reviewer({ emailVerified: false }), "verification.queue")).toBe(
      false,
    );
    for (const role of [
      "support",
      "moderator",
      "billing",
      "super_admin",
    ] as const)
      expect(can(reviewer({ roles: [role] }), "verification.queue")).toBe(
        false,
      );
    expect(
      can(
        reviewer({ roles: ["support", "verification_reviewer"] }),
        "verification.queue",
      ),
    ).toBe(true);
  });

  it("reads any other user's submission, in any status", () => {
    for (const status of SUBMISSION_STATUSES)
      expect(
        can(reviewer(), "verification.read", { ownerId: OWNER, status }),
      ).toBe(true);
  });

  it("views documents, reveals the ID and decides only while pending", () => {
    for (const action of REVIEW_ACTIONS) {
      expect(
        can(reviewer(), action, { ownerId: OWNER, status: "pending" }),
      ).toBe(true);
      for (const status of ["verified", "rejected", "expired"] as const)
        expect(can(reviewer(), action, { ownerId: OWNER, status })).toBe(false);
      // Status is required, not assumed.
      expect(can(reviewer(), action, { ownerId: OWNER })).toBe(false);
    }
  });

  it("never acts on their own submission", () => {
    const self = reviewer({ userId: OWNER });
    for (const action of ["verification.read", ...REVIEW_ACTIONS] as const)
      expect(can(self, action, { ownerId: OWNER, status: "pending" })).toBe(
        false,
      );
  });

  it("is denied without MFA or role for every submission action", () => {
    for (const action of ["verification.read", ...REVIEW_ACTIONS] as const) {
      expect(
        can(reviewer({ mfaSatisfied: false }), action, {
          ownerId: OWNER,
          status: "pending",
        }),
      ).toBe(false);
      expect(
        can(reviewer({ roles: [] }), action, {
          ownerId: OWNER,
          status: "pending",
        }),
      ).toBe(false);
    }
  });
});

describe("verification policy: fails closed", () => {
  it("denies without actor, resource, owner or a known action", () => {
    expect(can(null, "verification.queue")).toBe(false);
    expect(can(undefined, "verification.submit", { ownerId: OWNER })).toBe(
      false,
    );
    expect(can(user(), "verification.submit")).toBe(false);
    expect(can(user(), "verification.submit", { ownerId: "" })).toBe(false);
    expect(
      can(reviewer(), "verification.decide", {
        ownerId: OWNER,
        status: "approved" as never,
      }),
    ).toBe(false);
    expect(
      can(reviewer(), "verification.delete" as VerificationAction, {
        ownerId: OWNER,
        status: "pending",
      }),
    ).toBe(false);
  });
});
