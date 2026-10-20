import { expect, type Page } from "@playwright/test";
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
