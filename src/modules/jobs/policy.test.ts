import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/policy";
import {
  APPLICATION_STATUSES,
  APPLICATION_TRANSITIONS,
  JOB_STATUSES,
  type JobStatus,
} from "./constants";
import { can, canApplication, type JobAction } from "./policy";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "u-1",
    emailVerified: true,
    roles: [],
    mfaSatisfied: false,
    ...overrides,
  };
}

const moderator = actor({ roles: ["moderator"], mfaSatisfied: true });

const EMPLOYER: readonly JobAction[] = [
  "job.read",
  "job.copy",
  "job.edit",
  "job.delete",
  "job.submit",
  "job.pause",
  "job.resume",
  "job.close",
];

// The status each action needs (ADR-006).
const ALLOWED: Record<string, readonly JobStatus[]> = {
  "job.read": JOB_STATUSES,
  "job.copy": JOB_STATUSES,
  "job.edit": ["draft", "rejected"],
  "job.delete": ["draft"],
  "job.submit": ["draft", "rejected"],
  "job.pause": ["published"],
  "job.resume": ["paused"],
  "job.close": ["published", "paused"],
};

describe("jobs policy: employers", () => {
  it.each(["owner", "recruiter"] as const)(
    "a %s may act on the organization's jobs per status",
    (role) => {
      expect(can(actor(), "job.create", { actorRole: role })).toBe(true);
      for (const action of EMPLOYER)
        for (const status of JOB_STATUSES)
          expect(
            can(actor(), action, { actorRole: role, status }),
            `${action} on ${status}`,
          ).toBe(ALLOWED[action]?.includes(status));
    },
  );

  it("refuses non-members, unverified emails, unknown statuses and staff", () => {
    for (const action of [...EMPLOYER, "job.create" as const]) {
      expect(can(actor(), action, { status: "draft" })).toBe(false);
      expect(can(actor(), action, { actorRole: null, status: "draft" })).toBe(
        false,
      );
      expect(
        can(actor({ emailVerified: false }), action, {
          actorRole: "owner",
          status: "draft",
        }),
      ).toBe(false);
      expect(can(moderator, action, { status: "draft" })).toBe(false);
      expect(can(null, action, { actorRole: "owner", status: "draft" })).toBe(
        false,
      );
    }
    expect(
      can(actor(), "job.edit", {
        actorRole: "owner",
        status: "archived" as JobStatus,
      }),
    ).toBe(false);
  });
});

describe("jobs policy: moderators", () => {
  it("needs the moderator role with MFA", () => {
    expect(can(moderator, "job.reviewQueue")).toBe(true);
    expect(can(actor({ roles: ["moderator"] }), "job.reviewQueue")).toBe(false);
    expect(
      can(
        actor({ roles: ["verification_reviewer"], mfaSatisfied: true }),
        "job.reviewQueue",
      ),
    ).toBe(false);
  });

  it("reviews only pending jobs of organizations they do not belong to", () => {
    expect(can(moderator, "job.review", { status: "pending_review" })).toBe(
      true,
    );
    for (const status of JOB_STATUSES.filter((s) => s !== "pending_review"))
      expect(can(moderator, "job.review", { status })).toBe(false);
    for (const actorRole of ["owner", "recruiter"] as const)
      expect(
        can(moderator, "job.review", { actorRole, status: "pending_review" }),
      ).toBe(false);
  });
});

describe("applications policy (ADR-007)", () => {
  const me = actor({ userId: "applicant-1" });

  it("lets anyone outside the organization apply, never members", () => {
    expect(canApplication(me, "application.apply", {})).toBe(true);
    expect(canApplication(me, "application.apply", { actorRole: null })).toBe(
      true,
    );
    for (const actorRole of ["owner", "recruiter"] as const)
      expect(canApplication(me, "application.apply", { actorRole })).toBe(
        false,
      );
    expect(
      canApplication(actor({ emailVerified: false }), "application.apply", {}),
    ).toBe(false);
  });

  it("lets only the applicant read and withdraw, before a final decision", () => {
    expect(
      canApplication(me, "application.readOwn", { applicantId: "applicant-1" }),
    ).toBe(true);
    expect(
      canApplication(me, "application.readOwn", { applicantId: "someone" }),
    ).toBe(false);
    for (const status of APPLICATION_STATUSES)
      expect(
        canApplication(me, "application.withdraw", {
          applicantId: "applicant-1",
          status,
        }),
        status,
      ).toBe(["submitted", "under_review", "shortlisted"].includes(status));
    expect(
      canApplication(me, "application.withdraw", {
        applicantId: "someone",
        status: "submitted",
      }),
    ).toBe(false);
  });

  it("lets the job's organization move applications only along the table, never withdraw", () => {
    for (const actorRole of ["owner", "recruiter"] as const) {
      expect(canApplication(me, "application.read", { actorRole })).toBe(true);
      for (const status of APPLICATION_STATUSES)
        for (const to of APPLICATION_STATUSES)
          expect(
            canApplication(me, "application.move", {
              actorRole,
              applicantId: "applicant-2",
              status,
              to,
              jobStatus: "published",
            }),
            `${status} -> ${to}`,
          ).toBe(
            to !== "withdrawn" && APPLICATION_TRANSITIONS[status].includes(to),
          );
    }
    expect(canApplication(me, "application.read", {})).toBe(false);
    expect(
      canApplication(me, "application.move", {
        status: "submitted",
        to: "under_review",
      }),
    ).toBe(false);
    expect(
      canApplication(moderator, "application.read", { actorRole: null }),
    ).toBe(false);
    // Never on one's own application, and the applicant must be known.
    for (const applicantId of ["applicant-1", undefined])
      expect(
        canApplication(me, "application.move", {
          actorRole: "owner",
          applicantId,
          status: "submitted",
          to: "under_review",
        }),
      ).toBe(false);
  });
});

describe("takedown and reports (ADR-009)", () => {
  it("lets a moderator outside the organization take down live jobs only", () => {
    for (const status of JOB_STATUSES)
      expect(
        can(moderator, "job.takedown", { actorRole: null, status }),
        status,
      ).toBe(status === "published" || status === "paused");
    expect(
      can(moderator, "job.takedown", {
        actorRole: "owner",
        status: "published",
      }),
    ).toBe(false);
    expect(
      can({ ...moderator, mfaSatisfied: false }, "job.takedown", {
        actorRole: null,
        status: "published",
      }),
    ).toBe(false);
    expect(
      can(actor(), "job.takedown", { actorRole: null, status: "published" }),
    ).toBe(false);
  });

  it("lets verified members report published jobs of other organizations", () => {
    for (const status of JOB_STATUSES)
      expect(
        can(actor(), "job.report", { actorRole: null, status }),
        status,
      ).toBe(status === "published");
    for (const actorRole of ["owner", "recruiter"] as const)
      expect(
        can(actor(), "job.report", { actorRole, status: "published" }),
      ).toBe(false);
    expect(
      can(actor({ emailVerified: false }), "job.report", {
        actorRole: null,
        status: "published",
      }),
    ).toBe(false);
  });

  it("freezes the applications of a removed job", () => {
    const move = (jobStatus?: JobStatus) =>
      canApplication(actor(), "application.move", {
        actorRole: "owner",
        applicantId: "applicant-2",
        status: "submitted",
        to: "under_review",
        jobStatus,
      });
    expect(move("published")).toBe(true);
    expect(move("closed")).toBe(true);
    expect(move("removed")).toBe(false);
    // Fails closed without the job's status.
    expect(move(undefined)).toBe(false);
  });
});
