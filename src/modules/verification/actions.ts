"use server";

import { getLocale } from "next-intl/server";
import { getActor, requireActor } from "@/modules/identity/policy";
import { getDb } from "@/shared/db/client";
import { isEmailLocale } from "./constants";
import {
  decisionDeps,
  requestIp,
  verificationDeps,
  verificationLogger as log,
} from "./deps";
import { getNationalIdKeys } from "./keys";
import { can } from "./policy";
import {
  decide,
  type DecideResult,
  revealNationalId,
  submitVerification,
  type SubmitResult,
} from "./service";
import { formDataToRaw } from "./validation";

// Server actions for the verification pages. Each resolves the caller from
// the session, checks the verification policy, and passes only the form
// fields to the service, which validates them and takes owner ids from the
// Actor. Results are plain codes; the UI maps them to messages. Logs carry ids
// and error names only, never form values (the national ID).

type Unavailable = { ok: false; error: "unavailable" };

function failed(event: string, userId: string, error: unknown): Unavailable {
  log.error(
    {
      event,
      userId,
      errName: error instanceof Error ? error.name : undefined,
    },
    "verification action failed",
  );
  return { ok: false, error: "unavailable" };
}

export async function submitVerificationAction(
  form: FormData,
): Promise<SubmitResult | Unavailable> {
  const actor = await requireActor();
  if (!can(actor, "verification.submit", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  const locale = await getLocale();
  try {
    return await submitVerification(
      await verificationDeps(),
      actor,
      formDataToRaw(form),
      isEmailLocale(locale) ? locale : "ar",
    );
  } catch (error) {
    return failed("verification.submit.failed", actor.userId, error);
  }
}

export type RevealActionResult =
  | { ok: true; nationalId: string }
  | { ok: false; error: "not_found" | "forbidden" | "unavailable" };

/** Reveals one pending submission's national ID to a reviewer, logged first. */
export async function revealNationalIdAction(
  submissionId: string,
): Promise<RevealActionResult> {
  const actor = await getActor();
  if (!actor || !can(actor, "verification.queue"))
    return { ok: false, error: "forbidden" };
  try {
    return await revealNationalId(
      { db: getDb(), keys: getNationalIdKeys(), logger: log },
      actor,
      submissionId,
      await requestIp(),
    );
  } catch (error) {
    return failed("verification.reveal.failed", actor.userId, error);
  }
}

export async function decideAction(
  submissionId: string,
  form: FormData,
): Promise<DecideResult | Unavailable> {
  const actor = await getActor();
  if (!actor || !can(actor, "verification.queue"))
    return { ok: false, error: "forbidden" };
  try {
    return await decide(
      await decisionDeps(),
      actor,
      submissionId,
      formDataToRaw(form),
      await requestIp(),
    );
  } catch (error) {
    return failed("verification.decide.failed", actor.userId, error);
  }
}
