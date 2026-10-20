import "server-only";
import { getLocale } from "next-intl/server";
import { headers } from "next/headers";
import { cache } from "react";
import { getDb } from "@/shared/db/client";
import { redirect } from "@/shared/i18n/navigation";
import { getAuth } from "./auth";
import { STAFF_ROLES, type StaffRole } from "./roles";
import { listRoles } from "./roles-service";

/** The authenticated caller as the policy sees it. Built only on the server. */
export type Actor = {
  userId: string;
  emailVerified: boolean;
  roles: readonly StaffRole[];
  /** TOTP is enabled AND the current session was created by passing it. */
  mfaSatisfied: boolean;
};

/** Actions on the caller's own account. The resource names its owner. */
type OwnAccountAction = "account.read" | "account.manage";

/** Staff actions: each needs one of the listed roles plus satisfied MFA. */
const STAFF_ACTION_ROLES = {
  // Enter the staff area at all.
  "staff.access": STAFF_ROLES,
  "support.access": ["support"],
  "moderation.access": ["moderator"],
  "verification.review": ["verification_reviewer"],
  "billing.access": ["billing"],
  // Separation of duties: super_admin manages roles; it is not a superset of
  // the other duties. A person with several duties holds several roles.
  "roles.manage": ["super_admin"],
} as const satisfies Record<string, readonly StaffRole[]>;

type StaffAction = keyof typeof STAFF_ACTION_ROLES;

export type Action = OwnAccountAction | StaffAction;

export type Resource = { ownerId: string };

/** The staff action that stands for holding a given role. */
export const ROLE_ACTION: Record<StaffRole, StaffAction> = {
  support: "support.access",
  moderator: "moderation.access",
  verification_reviewer: "verification.review",
  billing: "billing.access",
  super_admin: "roles.manage",
};

function isStaffAction(action: string): action is StaffAction {
  return Object.hasOwn(STAFF_ACTION_ROLES, action);
}

/**
 * The single authorization decision for the identity module. Fails closed: no
 * actor, an unknown action, a missing resource or any unmet condition → false.
 */
export function can(
  actor: Actor | null | undefined,
  action: Action,
  resource?: Resource,
): boolean {
  if (!actor) return false;
  const name: string = action;

  if (name === "account.read" || name === "account.manage") {
    return resource !== undefined && resource.ownerId === actor.userId;
  }

  if (isStaffAction(name)) {
    const allowed: readonly StaffRole[] = STAFF_ACTION_ROLES[name];
    return (
      actor.emailVerified &&
      actor.mfaSatisfied &&
      actor.roles.some((role) => allowed.includes(role))
    );
  }

  return false;
}

type SessionLike = {
  user: {
    id: string;
    emailVerified: boolean;
    twoFactorEnabled?: boolean | null;
  };
  session: { mfaVerifiedAt?: Date | string | null };
};

/** Builds an Actor from a Better Auth session result and the user's roles. */
export function actorFromSession(
  result: SessionLike,
  roles: readonly StaffRole[],
): Actor {
  return {
    userId: result.user.id,
    emailVerified: result.user.emailVerified === true,
    roles,
    mfaSatisfied:
      result.user.twoFactorEnabled === true &&
      result.session.mfaVerifiedAt != null,
  };
}

/**
 * Resolves the caller from the session cookie (database lookup, so revoked
 * sessions stop working immediately). Memoized per request.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const result = await getAuth().api.getSession({ headers: await headers() });
  if (!result) return null;
  const roles = await listRoles(getDb(), result.user.id);
  return actorFromSession(result, roles);
});

/** For pages and server actions: the actor, or a redirect to sign-in. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) {
    return redirect({ href: "/sign-in", locale: await getLocale() });
  }
  return actor;
}

/**
 * For staff pages and actions. Without a session → sign-in. Signed in but not
 * allowed → the account page with a notice: "staff_mfa_required" for role
 * holders who still need TOTP for this session, "staff_denied" otherwise.
 */
export async function requireStaff(role?: StaffRole): Promise<Actor> {
  const actor = await requireActor();
  const action: StaffAction = role ? ROLE_ACTION[role] : "staff.access";
  if (!can(actor, action)) {
    const notice =
      actor.roles.length > 0 && !actor.mfaSatisfied
        ? "staff_mfa_required"
        : "staff_denied";
    redirect({
      href: { pathname: "/account", query: { notice } },
      locale: await getLocale(),
    });
  }
  return actor;
}

/** Thrown by `authorize` for callers that answer with a status, not a redirect. */
export class AuthorizationError extends Error {
  constructor(readonly status: 401 | 403) {
    super(status === 401 ? "unauthenticated" : "forbidden");
    this.name = "AuthorizationError";
  }
}

/** For route handlers: throws 401 without a session, 403 when not allowed. */
export async function authorize(
  action: Action,
  resource?: Resource,
): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError(401);
  if (!can(actor, action, resource)) throw new AuthorizationError(403);
  return actor;
}
