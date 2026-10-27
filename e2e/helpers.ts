import { expect, type Page } from "@playwright/test";
import { totpFromSecret } from "../tests/integration/helpers/totp";
import { latestLinkTo } from "./mailpit";

// Shared journey steps for the E2E specs (Arabic UI, the default locale).

export const PASSWORD = "correct horse battery staple";

export function uniqueEmail(label: string) {
  return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

/** Fails the test on any CSP violation reported by the browser. */
export function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text()))
      violations.push(message.text());
  });
  return violations;
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

export async function signUpAndVerify(page: Page, email: string) {
  await page.goto("/sign-up");
  await page.getByLabel("البريد الإلكتروني").fill(email);
  await page.getByLabel("كلمة المرور").fill(PASSWORD);
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await expect(page).toHaveURL(/\/check-email$/);
  const link = await latestLinkTo(page.request, email, "تأكيد بريدك");
  expect(new URL(link).pathname).toBe("/verify-email");
  await page.goto(link);
  await expect(page.getByRole("status")).toContainText(
    "تم تأكيد بريدك الإلكتروني",
  );
}

export async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("البريد الإلكتروني").fill(email);
  await page.getByLabel("كلمة المرور").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
}

const usedCodes = new Map<string, Set<string>>();

/**
 * A TOTP code that was not used before for this secret. The server refuses a
 * code it already accepted (replay protection, ADR-008); when both the
 * current and the next step's codes were used, wait for a new step.
 */
export async function freshTotp(secret: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const used = usedCodes.get(secret) ?? new Set<string>();
    usedCodes.set(secret, used);
    // The current step's code, else the next step's (Better Auth accepts one
    // step of drift), so a second sign-in rarely has to wait.
    for (const offset of [0, 30_000]) {
      const code = totpFromSecret(secret, Date.now() + offset);
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("no fresh TOTP code");
}
