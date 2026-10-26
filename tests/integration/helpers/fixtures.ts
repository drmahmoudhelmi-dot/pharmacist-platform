import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { type Actor, actorFromSession } from "@/modules/identity/policy";
import { changeRole, listRoles } from "@/modules/identity/roles-service";
import { createJob, decideJob, submitJob } from "@/modules/jobs/service";
import {
  createOrganization,
  inviteMember,
  respondToInvitation,
} from "@/modules/organizations/service";
import type { PgBoss } from "@/shared/jobs/boss";
import type { CookieJar, Harness } from "./auth-harness";
import { totpFromUri } from "./totp";

// Shared test fixtures for the jobs and applications suites: real Better
// Auth accounts, a moderator whose session passed TOTP, organizations and a
// published job. Synthetic data only.

export const PASSWORD = "correct horse battery staple";

export type Person = { email: string; actor: Actor; jar: CookieJar };

export const jobForm = {
  title: "صيدلي مجتمع - وردية صباحية",
  category: "pharmacist",
  employmentType: "full_time",
  governorateId: "1",
  area: "مدينة نصر",
  description:
    "نبحث عن صيدلي للعمل في صيدلية مجتمع، مع خبرة في صرف الروشتات وخدمة العملاء.",
  minYearsExperience: "2",
  careerStages: ["graduate", "pharmacist"],
  salaryMin: "8000",
  salaryMax: "12000",
};

export function fixtures(h: Harness, boss: PgBoss) {
  let counter = 0;
  const deps = { db: h.db, boss };

  async function sessionActor(jar: CookieJar): Promise<Actor> {
    const current = await h.call("/get-session", { jar });
    const session = current.json as unknown as Parameters<
      typeof actorFromSession
    >[0];
    return actorFromSession(session, await listRoles(h.db, session.user.id));
  }

  async function person(label: string): Promise<Person> {
    counter += 1;
    const email = `${label}-${counter}@example.test`;
    await h.createVerifiedUser(email, PASSWORD);
    const { jar } = await h.signIn(email, PASSWORD);
    return { email, jar, actor: await sessionActor(jar) };
  }

  async function moderator(label = "moderator"): Promise<Person> {
    counter += 1;
    const email = `${label}-${counter}@example.test`;
    await h.createVerifiedUser(email, PASSWORD);
    await changeRole(h.db, { email, role: "moderator", change: "grant" });
    const { jar } = await h.signIn(email, PASSWORD);
    const enable = await h.call("/two-factor/enable", {
      body: { password: PASSWORD },
      jar,
    });
    await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(enable.json?.totpURI as string) },
      jar,
    });
    const actor = await sessionActor(jar);
    expect(actor.mfaSatisfied).toBe(true);
    return { email, jar, actor };
  }

  /** A synthetic verified submission (the workflow is in verification.test.ts). */
  async function markVerified(userId: string) {
    const hex = (n: number) => randomBytes(n).toString("hex");
    await h.pool.query(
      `insert into verification_submission
         (user_id, credential_type, status, legal_name_ar, syndicate_number,
          national_id_ciphertext, national_id_hash, national_id_masked, key_id,
          consent_version, decided_at)
       values ($1, 'pharmacist', 'verified', 'سامي فريد عبد الحميد', '12345',
          $2, $3, '2**********345', $4, 'test', now())`,
      [userId, `v1.${hex(8)}.aaaa.bbbb.cccc`, hex(32), hex(8)],
    );
  }

  async function organizationOf(owner: Person) {
    counter += 1;
    const result = await createOrganization(deps, owner.actor, {
      kind: "pharmacy",
      name: `صيدلية الاختبار ${counter}`,
      governorateId: "1",
      addressLine: "",
    });
    if (!result.ok) throw new Error(`organization: ${result.error}`);
    return result.organizationId;
  }

  async function addMember(
    owner: Person,
    organizationId: string,
    who: Person,
    role: "owner" | "recruiter" = "recruiter",
  ) {
    const sent = await inviteMember(deps, owner.actor, organizationId, {
      email: who.email,
      role,
    });
    if (!sent.ok) throw new Error("invite");
    await respondToInvitation(deps, who.actor, sent.invitationId, "accept");
  }

  /** An organization with one published job, posted by a verified owner. */
  async function publishedJob(form = jobForm) {
    const owner = await person("employer");
    await markVerified(owner.actor.userId);
    const organizationId = await organizationOf(owner);
    const mod = await moderator();
    const created = await createJob(deps, owner.actor, organizationId, form);
    if (!created.ok) throw new Error(`job: ${created.error}`);
    await submitJob(deps, owner.actor, created.jobId);
    const decided = await decideJob(deps, mod.actor, created.jobId, {
      decision: "approved",
    });
    if (!decided.ok) throw new Error(`approve: ${decided.error}`);
    return { owner, organizationId, jobId: created.jobId };
  }

  return {
    person,
    moderator,
    markVerified,
    organizationOf,
    addMember,
    publishedJob,
  };
}
