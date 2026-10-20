"use server";

import { requireActor } from "@/modules/identity/policy";
import { getDb } from "@/shared/db/client";
import { logger } from "@/shared/logging/logger";
import { can } from "./policy";
import {
  addOwnExperience,
  deleteOwnExperience,
  updateOwnExperience,
  upsertOwnProfessionalDetails,
  upsertOwnProfile,
  type WriteResult,
} from "./service";
import {
  type ExperienceField,
  formDataToRaw,
  type ProfessionalDetailsField,
  type ProfileField,
} from "./validation";

// Server actions for the owner's profile page. Each one resolves the caller
// from the session (requireActor), checks the profiles policy, and passes only
// the form fields to the service, which validates them and takes the owner id
// from the Actor. Results are plain codes; the UI maps them to messages.

export type ActionResult<K extends string = never> =
  WriteResult<K> | { ok: false; error: "generic" };

const log = logger.child({ module: "profiles" });

async function run<K extends string>(
  name: string,
  userId: string,
  work: () => Promise<WriteResult<K>>,
): Promise<ActionResult<K>> {
  try {
    const result = await work();
    if (result.ok) log.info({ event: `profiles.${name}`, userId });
    return result;
  } catch (error) {
    // Ids only: never form values, which hold personal data.
    log.error(
      {
        event: `profiles.${name}.failed`,
        userId,
        errName: error instanceof Error ? error.name : undefined,
      },
      "profile write failed",
    );
    return { ok: false, error: "generic" };
  }
}

export async function saveProfileAction(
  form: FormData,
): Promise<ActionResult<ProfileField>> {
  const actor = await requireActor();
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  return run("profile.saved", actor.userId, () =>
    upsertOwnProfile(getDb(), actor, formDataToRaw(form, ["specialties"])),
  );
}

export async function saveProfessionalDetailsAction(
  form: FormData,
): Promise<ActionResult<ProfessionalDetailsField>> {
  const actor = await requireActor();
  if (!can(actor, "professionalDetails.update", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  return run("details.saved", actor.userId, () =>
    upsertOwnProfessionalDetails(getDb(), actor, formDataToRaw(form)),
  );
}

export async function addExperienceAction(
  form: FormData,
): Promise<ActionResult<ExperienceField>> {
  const actor = await requireActor();
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  return run("experience.added", actor.userId, () =>
    addOwnExperience(getDb(), actor, formDataToRaw(form)),
  );
}

export async function updateExperienceAction(
  experienceId: string,
  form: FormData,
): Promise<ActionResult<ExperienceField>> {
  const actor = await requireActor();
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  return run("experience.updated", actor.userId, () =>
    updateOwnExperience(getDb(), actor, experienceId, formDataToRaw(form)),
  );
}

export async function deleteExperienceAction(
  experienceId: string,
): Promise<ActionResult> {
  const actor = await requireActor();
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  return run("experience.deleted", actor.userId, () =>
    deleteOwnExperience(getDb(), actor, experienceId),
  );
}
