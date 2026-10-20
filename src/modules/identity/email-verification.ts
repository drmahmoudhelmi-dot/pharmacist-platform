import "server-only";
import { isAPIError } from "better-auth/api";
import { logger } from "@/shared/logging/logger";
import { getAuth } from "./auth";

export type VerifyOutcome = "verified" | "invalid";

/**
 * Checks an email-verification token server-side. The token is a signed,
 * expiring value (24 h); once the address is verified, reusing the link
 * changes nothing. Library errors are reduced to "invalid" for the page.
 */
export async function verifyEmailToken(
  token: string,
  headers: Headers,
): Promise<VerifyOutcome> {
  try {
    await getAuth().api.verifyEmail({ query: { token }, headers });
    return "verified";
  } catch (error) {
    if (!isAPIError(error)) {
      logger.error(
        {
          event: "auth.verify_email.failed",
          errName: error instanceof Error ? error.name : "unknown",
        },
        "email verification failed unexpectedly",
      );
    }
    return "invalid";
  }
}
