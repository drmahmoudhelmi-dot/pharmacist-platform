import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { totpFromSecret } from "../tests/integration/helpers/totp";
import { latestLinkTo } from "./mailpit";

const exec = promisify(execFile);

const PASSWORD = "correct horse battery staple";

// Every request comes from 127.0.0.1 and the real per-IP limits apply
// (sign-up 3 per hour, sign-in 5 per 15 min; global-setup clears them before a
// run). This file stays within them: 3 sign-ups, 4 sign-ins. Serial so the
// order, and therefore the counts, are stable.
test.describe.configure({ mode: "serial" });

function uniqueEmail(label: string) {
  return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

/** Fails the test on any CSP violation reported by the browser. */
function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text()))
      violations.push(message.text());
  });
  return violations;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signUpAndVerify(page: Page, email: string) {
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

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("البريد الإلكتروني").fill(email);
  await page.getByLabel("كلمة المرور").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
}

test("register, verify by email, sign in, see the account, sign out (Arabic RTL, 360px)", async ({
  page,
}) => {
  const csp = watchCsp(page);
  const email = uniqueEmail("journey");

  await page.goto("/sign-up");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "إنشاء حساب",
  );
  await expectNoHorizontalScroll(page);

  // Client-side checks answer in Arabic before anything is sent.
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await expect(page.getByText("هذا الحقل مطلوب.").first()).toBeVisible();

  await signUpAndVerify(page, email);

  await signIn(page, email);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("حسابي");
  await expect(page.getByTestId("account-email")).toHaveText(email);
  await expect(page.getByText("مؤكد", { exact: true })).toBeVisible();
  await expect(page.getByTestId("totp-state")).toHaveText("غير مفعّل");
  await expectNoHorizontalScroll(page);

  const cookie = (await page.context().cookies()).find((c) =>
    c.name.endsWith("session_token"),
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");

  await page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in\?notice=signed_out$/);
  await expect(page.getByRole("status")).toContainText("تم تسجيل الخروج");

  // The session is gone on the server, not just hidden.
  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(csp).toEqual([]);
});

test("sign-in before verification shows a localized message and no session", async ({
  page,
}) => {
  const email = uniqueEmail("unverified");
  await page.goto("/sign-up");
  await page.getByLabel("البريد الإلكتروني").fill(email);
  await page.getByLabel("كلمة المرور").fill(PASSWORD);
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await expect(page).toHaveURL(/\/check-email$/);

  await signIn(page, email);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "لم يتم تأكيد بريدك الإلكتروني" }),
  ).toBeVisible();
  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("pages carry the security headers", async ({ page }) => {
  const response = await page.goto("/sign-in");
  const headers = response!.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["content-security-policy"]).toContain("'strict-dynamic'");
  expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
});

test("the staff area is denied to a regular user and opens after TOTP and a role grant", async ({
  page,
}) => {
  // Signed out: sent to sign-in.
  await page.goto("/staff");
  await expect(page).toHaveURL(/\/sign-in$/);

  const email = uniqueEmail("regular");
  await signUpAndVerify(page, email);
  await signIn(page, email);
  await expect(page).toHaveURL(/\/account$/);

  await page.goto("/staff");
  await expect(page).toHaveURL(/\/account\?notice=staff_denied$/);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "ليست لديك صلاحية الدخول إلى منطقة فريق العمل" }),
  ).toBeVisible();

  // Now make this user staff the only supported way: TOTP first, then the CLI.
  await page.getByRole("button", { name: "تفعيل التحقق بخطوتين" }).click();
  await page.getByLabel("أكّد كلمة المرور للمتابعة").fill(PASSWORD);
  await page.getByRole("button", { name: "متابعة" }).click();
  const secret = await page.getByTestId("totp-secret").innerText();
  await expect(page.getByTestId("backup-codes").locator("li")).toHaveCount(10);
  await page.getByLabel("رمز التحقق").fill(totpFromSecret(secret));
  await page.getByRole("button", { name: "إكمال التفعيل" }).click();
  await expect(page.getByTestId("totp-state")).toHaveText("مفعّل");

  const cli = await exec("pnpm", [
    "--silent",
    "admin:grant-role",
    email,
    "support",
  ]);
  expect(cli.stdout).toContain("Role granted");

  // The grant revoked every session: sign in again, this time with TOTP.
  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page, email);
  await expect(
    page.getByRole("heading", { name: "التحقق بخطوتين" }),
  ).toBeVisible();
  await page.getByLabel("رمز التحقق").fill(totpFromSecret(secret));
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(page).toHaveURL(/\/account$/);

  await page.getByRole("link", { name: "منطقة فريق العمل" }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "منطقة فريق العمل",
  );
  await expect(page.getByText("الدعم")).toBeVisible();
});
