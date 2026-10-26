import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  expectNoHorizontalScroll,
  freshTotp,
  PASSWORD,
  signIn,
  signUpAndVerify,
  uniqueEmail,
  watchCsp,
} from "./helpers";

// Staff role management and the audit log (ADR-008) in Arabic at 360 px. A
// super admin (TOTP + role from the operator CLI) grants "moderator" to a
// second account, sees it listed, revokes it after a confirmation, cannot
// revoke their own role, and finds both changes in /staff/audit. A member
// without a staff role is sent away from /staff/roles.

const exec = promisify(execFile);

// Own sign-up budget (CGNAT range, unused by the other specs).
function clientIp() {
  return `100.64.0.${1 + Math.floor(Math.random() * 254)}`;
}

test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "x-forwarded-for": clientIp() } });

async function newClient(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 360, height: 780 },
    locale: "ar-EG",
    extraHTTPHeaders: { "x-forwarded-for": clientIp() },
  });
  return { context, page: await context.newPage() };
}

async function becomeSuperAdmin(page: Page, email: string) {
  await signUpAndVerify(page, email);
  await signIn(page, email);
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole("button", { name: "تفعيل التحقق بخطوتين" }).click();
  await page.getByLabel("أكّد كلمة المرور للمتابعة").fill(PASSWORD);
  await page.getByRole("button", { name: "متابعة" }).click();
  const secret = await page.getByTestId("totp-secret").innerText();
  await page.getByLabel("رمز التحقق").fill(await freshTotp(secret));
  await page.getByRole("button", { name: "إكمال التفعيل" }).click();
  await expect(page.getByTestId("totp-state")).toHaveText("مفعّل");
  const cli = await exec("pnpm", [
    "--silent",
    "admin:grant-role",
    email,
    "super_admin",
  ]);
  expect(cli.stdout).toContain("Role granted");
  await page.goto("/sign-in");
  await signIn(page, email);
  await page.getByLabel("رمز التحقق").fill(await freshTotp(secret));
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(page).toHaveURL(/\/account$/);
}

test("a super admin grants and revokes a role and finds both in the audit log (360px)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const csp = watchCsp(page);
  const admin = uniqueEmail("admin");
  const member = uniqueEmail("member");

  // --- A second verified account, not staff.
  const other = await newClient(browser, baseURL);
  await signUpAndVerify(other.page, member);
  await signIn(other.page, member);
  await expect(other.page).toHaveURL(/\/account$/);
  // A member without a staff role is sent away from the staff pages.
  await other.page.goto("/staff/roles");
  await expect(other.page).toHaveURL(/\/account\?notice=staff_denied$/);
  await other.page.goto("/staff/audit");
  await expect(other.page).toHaveURL(/\/account\?notice=staff_denied$/);

  // --- The super admin.
  await becomeSuperAdmin(page, admin);
  await page.goto("/staff");
  await page.getByRole("link", { name: "أدوار فريق العمل" }).click();
  await expect(page).toHaveURL(/\/staff\/roles$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("يُخرجه من حسابه على كل الأجهزة")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Own account: listed, with an explanation and no revoke button.
  const own = page.getByTestId("staff-account").filter({ hasText: admin });
  await expect(own).toHaveCount(1);
  await expect(own.getByTestId("self-note")).toBeVisible();
  await expect(own.getByRole("button")).toHaveCount(0);

  // --- Grant moderator to the second account.
  await page.getByLabel("البريد الإلكتروني للحساب").fill(member);
  await page.getByLabel("الدور", { exact: true }).selectOption({
    label: "الإشراف على المحتوى",
  });
  await page.getByRole("button", { name: "منح الدور" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم منح الدور" }),
  ).toBeVisible();
  const granted = page.getByTestId("staff-account").filter({ hasText: member });
  await expect(granted).toHaveCount(1);
  await expect(granted.getByTestId("staff-role")).toContainText(
    "الإشراف على المحتوى",
  );
  await expect(granted).toContainText(admin);
  await expectNoHorizontalScroll(page);

  // An unknown account is refused with a localized message.
  await page.getByLabel("البريد الإلكتروني للحساب").fill(uniqueEmail("nobody"));
  await page.getByLabel("الدور", { exact: true }).selectOption({
    label: "الدعم",
  });
  await page.getByRole("button", { name: "منح الدور" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "لا يوجد حساب بهذا البريد" }),
  ).toBeVisible();

  // --- Revoke it, after a confirmation.
  await granted
    .getByRole("button", { name: "سحب دور الإشراف على المحتوى" })
    .click();
  await expect(granted.getByText("هل تريد سحب هذا الدور")).toBeVisible();
  await granted.getByRole("button", { name: "إلغاء" }).click();
  await expect(granted.getByTestId("staff-role")).toHaveCount(1);
  await granted
    .getByRole("button", { name: "سحب دور الإشراف على المحتوى" })
    .click();
  await granted.getByRole("button", { name: "نعم، اسحب الدور" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم سحب الدور" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("staff-account").filter({ hasText: member }),
  ).toHaveCount(0);

  // --- The audit log has both changes.
  await page.goto("/staff");
  await page.getByRole("link", { name: "سجل التدقيق" }).click();
  await expect(page).toHaveURL(/\/staff\/audit$/);
  await expectNoHorizontalScroll(page);
  await page.getByLabel("البريد الإلكتروني للمنفِّذ").fill(admin);
  await page.getByRole("button", { name: "تصفية" }).click();
  await expect(page).toHaveURL(/actorEmail=/);
  const entries = page.getByTestId("audit-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toHaveAttribute("data-action", "role.revoked");
  await expect(entries.first()).toContainText("سحب دور");
  await expect(entries.first()).toContainText("الإشراف على المحتوى");
  await expect(entries.nth(1)).toHaveAttribute("data-action", "role.granted");
  await expectNoHorizontalScroll(page);

  // Filter by action.
  await page.getByLabel("الإجراء").selectOption({ label: "منح دور" });
  await page.getByRole("button", { name: "تصفية" }).click();
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toHaveAttribute("data-action", "role.granted");

  // A filter that matches nothing shows the empty state.
  await page
    .getByLabel("الإجراء")
    .selectOption({ label: "تصدير بيانات الحساب" });
  await page.getByRole("button", { name: "تصفية" }).click();
  await expect(page.getByTestId("audit-empty")).toBeVisible();
  await expectNoHorizontalScroll(page);

  expect(csp).toEqual([]);
  await other.context.close();
});
