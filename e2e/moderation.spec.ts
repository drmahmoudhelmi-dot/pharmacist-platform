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

// Reports, takedown and account suspension (ADR-009) in Arabic at 360 px. An
// employer's first job is approved by a moderator and goes live. A member
// reports it; the moderator finds it in /staff/reports, opens it and takes
// it down. The public page answers 404 and the employer sees the removed
// status and the reason, with only the copy action left. Then the moderator
// looks up the member on /staff/accounts and suspends them; the member's
// sign-in shows the suspended message; the moderator reinstates them and
// sign-in works again.

const exec = promisify(execFile);

// Own sign-up budget (second half of the benchmarking range, 198.18.0.0/15;
// applications.spec.ts uses 198.18.0.x).
function clientIp() {
  return `198.19.0.${1 + Math.floor(Math.random() * 254)}`;
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

/** A moderator: TOTP on, role granted by the CLI, signed in with TOTP. */
async function becomeModerator(page: Page, email: string) {
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
    "moderator",
  ]);
  expect(cli.stdout).toContain("Role granted");
  await page.goto("/sign-in");
  await signIn(page, email);
  await page.getByLabel("رمز التحقق").fill(await freshTotp(secret));
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(page).toHaveURL(/\/account$/);
}

test("a reported job is taken down and a member is suspended, then reinstated (360px)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const csp = watchCsp(page);
  const stamp = `M${Date.now()}`;
  const title = `صيدلي مساء ${stamp}`;

  // --- Employer: organization and a published job (approved by a moderator).
  const owner = uniqueEmail("mod-owner");
  await signUpAndVerify(page, owner);
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/organizations");
  await page.getByLabel("اسم المنشأة").fill("صيدلية البلاغات");
  await page.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await page.getByRole("button", { name: "إنشاء المنشأة" }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}$/);
  await page.getByRole("link", { name: "وظائف المنشأة" }).click();
  await page.getByRole("link", { name: "وظيفة جديدة" }).first().click();
  await page.getByLabel("عنوان الوظيفة").fill(title);
  await page.getByLabel("نوع الوظيفة").selectOption({ label: "صيدلي" });
  await page.getByRole("radio", { name: "دوام كامل" }).check();
  await page.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await page
    .getByLabel("وصف الوظيفة")
    .fill(
      "مطلوب صيدلي للعمل بالوردية المسائية في صيدلية بالدقي، مع الالتزام بالمواعيد.",
    );
  await page.getByRole("checkbox", { name: "صيدلي" }).check();
  await page.getByRole("button", { name: "حفظ المسودة" }).click();
  await expect(page).toHaveURL(/\/manage\/jobs\/[0-9a-f-]{36}$/);
  const jobPath = new URL(page.url()).pathname;
  const jobId = jobPath.split("/").pop()!;
  await page.getByRole("button", { name: "إرسال للنشر" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("قيد المراجعة");

  const mod = await newClient(browser, baseURL);
  const modCsp = watchCsp(mod.page);
  const modEmail = uniqueEmail("mod-moderator");
  await becomeModerator(mod.page, modEmail);
  await mod.page.goto(`/staff/jobs/${jobId}`);
  await mod.page.getByRole("radio", { name: "موافقة ونشر" }).check();
  await mod.page.getByRole("button", { name: "تسجيل القرار" }).click();
  await mod.page.getByRole("button", { name: "تأكيد الموافقة" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/jobs$/);

  // --- A signed-out visitor sees no report section; the owner neither.
  const visitor = await newClient(browser, baseURL);
  const visitorCsp = watchCsp(visitor.page);
  expect((await visitor.page.goto(`/jobs/${jobId}`))?.status()).toBe(200);
  await expect(visitor.page.getByTestId("report-section")).toHaveCount(0);
  await expect(visitor.page.getByTestId("report-confirmation")).toHaveCount(0);
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("report-section")).toHaveCount(0);

  // --- A member reports it (the reporter is suspended later on).
  const member = uniqueEmail("mod-member");
  const reporter = await newClient(browser, baseURL);
  const reporterCsp = watchCsp(reporter.page);
  await signUpAndVerify(reporter.page, member);
  await signIn(reporter.page, member);
  await expect(reporter.page).toHaveURL(/\/account$/);
  await reporter.page.goto(`/jobs/${jobId}`);
  await expect(reporter.page.getByTestId("report-section")).toBeVisible();
  await expectNoHorizontalScroll(reporter.page);
  await reporter.page.getByText("الإبلاغ عن هذه الوظيفة").click();
  await expectNoHorizontalScroll(reporter.page);
  // A report without a reason is refused locally.
  await reporter.page.getByRole("button", { name: "إرسال البلاغ" }).click();
  await expect(reporter.page.getByText("هذا الحقل مطلوب.")).toBeVisible();
  await reporter.page
    .getByLabel("سبب البلاغ")
    .selectOption({ label: "وظيفة وهمية أو احتيال" });
  await reporter.page.getByLabel("تفاصيل (اختياري)").fill("تطلب مبلغًا مقدمًا");
  await reporter.page.getByRole("button", { name: "إرسال البلاغ" }).click();
  await expect(
    reporter.page.getByRole("status").filter({ hasText: "وصل بلاغك" }),
  ).toBeVisible();
  // After the refresh the page says it was reported, with no second form.
  await reporter.page.reload();
  await expect(reporter.page.getByTestId("report-confirmation")).toBeVisible();
  await expect(reporter.page.getByTestId("report-form")).toHaveCount(0);

  // --- The moderator finds it in the reports queue and opens it.
  await mod.page.goto("/staff");
  // The staff home shows the moderator's duty cards with live counts; this
  // job has an open report, so that count is not zero.
  await expect(mod.page.getByTestId("staff-card-jobs")).toBeVisible();
  await expect(mod.page.getByTestId("staff-count-jobs")).toBeVisible();
  await expect(mod.page.getByTestId("staff-count-reports")).toHaveText(/[١-٩]/);
  await expect(mod.page.getByTestId("staff-card-verification")).toHaveCount(0);
  await expectNoHorizontalScroll(mod.page);
  await mod.page.getByRole("link", { name: "الوظائف المُبلَّغ عنها" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/reports$/);
  await expect(mod.page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoHorizontalScroll(mod.page);
  const item = mod.page
    .getByTestId("report-queue-item")
    .filter({ hasText: stamp });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("صيدلية البلاغات");
  await expect(item).toContainText("وظيفة وهمية أو احتيال");
  await item.click();
  await expect(mod.page).toHaveURL(new RegExp(`/staff/reports/${jobId}$`));
  await expect(mod.page.getByTestId("reported-job-title")).toHaveText(title);
  const report = mod.page.getByTestId("report");
  await expect(report).toHaveCount(1);
  await expect(report).toContainText("وظيفة وهمية أو احتيال");
  await expect(report).toContainText("تطلب مبلغًا مقدمًا");
  await expect(report).toContainText(member);
  await expectNoHorizontalScroll(mod.page);

  // Taking down needs a reason, then a confirmation.
  await mod.page.getByRole("button", { name: "إزالة الوظيفة" }).click();
  await expect(mod.page.getByText("هذا الحقل مطلوب.")).toBeVisible();
  await mod.page
    .getByLabel("سبب الإزالة")
    .selectOption({ label: "الإعلان مضلل أو يبدو احتياليًا." });
  await mod.page
    .getByLabel("ملاحظة داخلية (اختياري)")
    .fill("طلب مبلغًا مقدمًا");
  await mod.page.getByRole("button", { name: "إزالة الوظيفة" }).click();
  await expect(mod.page.getByText("ستُزال الوظيفة الآن")).toBeVisible();
  await mod.page.getByRole("button", { name: "تأكيد الإزالة" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/reports$/);
  await expect(
    mod.page.getByTestId("report-queue-item").filter({ hasText: stamp }),
  ).toHaveCount(0);

  // --- The public page is gone; the employer sees the removal.
  expect((await visitor.page.goto(`/jobs/${jobId}`))?.status()).toBe(404);
  expect((await reporter.page.goto(`/jobs/${jobId}`))?.status()).toBe(404);
  await page.goto(jobPath);
  await expect(page.getByTestId("job-status")).toHaveText("أُزيلت");
  const removal = page.getByTestId("job-removal");
  await expect(removal).toContainText("الإعلان مضلل أو يبدو احتياليًا.");
  await expect(removal).toContainText("أُزيلت بتاريخ");
  await expect(removal).not.toContainText("طلب مبلغًا مقدمًا");
  await expect(page.getByTestId("job-public-link")).toHaveCount(0);
  await expect(page.getByTestId("job-form")).toHaveCount(0);
  const actions = page.getByTestId("job-actions");
  await expect(
    actions.getByRole("button", { name: "إنشاء نسخة جديدة" }),
  ).toBeVisible();
  await expect(actions.getByRole("button")).toHaveCount(1);
  await expectNoHorizontalScroll(page);

  // --- Account lookup: a member without a staff role is sent away.
  await reporter.page.goto("/staff/accounts");
  await expect(reporter.page).toHaveURL(/\/account\?notice=staff_denied$/);
  await reporter.page.goto("/staff/reports");
  await expect(reporter.page).toHaveURL(/\/account\?notice=staff_denied$/);

  // --- The moderator looks up accounts.
  await mod.page.goto("/staff");
  await mod.page.getByRole("link", { name: "الحسابات" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/accounts$/);
  await expectNoHorizontalScroll(mod.page);
  // Unknown address.
  await mod.page.getByLabel("البريد الإلكتروني للحساب").fill(uniqueEmail("no"));
  await mod.page.getByRole("button", { name: "بحث" }).click();
  await expect(mod.page.getByTestId("account-not-found")).toBeVisible();
  // Own account: shown, but no way to act.
  await mod.page.getByLabel("البريد الإلكتروني للحساب").fill(modEmail);
  await mod.page.getByRole("button", { name: "بحث" }).click();
  await expect(mod.page.getByTestId("account-card")).toContainText(
    "الإشراف على المحتوى",
  );
  await expect(mod.page.getByTestId("cannot-act")).toContainText("حسابك أنت");
  await expect(mod.page.getByTestId("suspend-form")).toHaveCount(0);

  // The member: active, never suspended.
  await mod.page.getByLabel("البريد الإلكتروني للحساب").fill(member);
  await mod.page.getByRole("button", { name: "بحث" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/accounts\?email=/);
  await expect(mod.page.getByTestId("account-card")).toContainText(member);
  await expect(mod.page.getByTestId("account-status")).toHaveText("نشط");
  await expect(mod.page.getByTestId("history-empty")).toBeVisible();
  await expectNoHorizontalScroll(mod.page);

  // Suspend: a reason is required, then a confirmation.
  await mod.page.getByRole("button", { name: "إيقاف الحساب" }).click();
  await expect(mod.page.getByText("اختر السبب.").first()).toBeVisible();
  await mod.page
    .getByLabel("سبب الإيقاف")
    .selectOption({ label: "رسائل أو محتوى مزعج" });
  await mod.page.getByLabel("ملاحظة داخلية (اختياري)").fill("بلاغات متكررة");
  await mod.page.getByRole("button", { name: "إيقاف الحساب" }).click();
  await expect(mod.page.getByText("سيُسجَّل خروج الحساب")).toBeVisible();
  await mod.page.getByRole("button", { name: "تأكيد الإيقاف" }).click();
  await expect(
    mod.page.getByRole("status").filter({ hasText: "تم إيقاف الحساب" }),
  ).toBeVisible();
  await expect(mod.page.getByTestId("account-status")).toHaveText("موقوف");
  const entry = mod.page.getByTestId("history-entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("رسائل أو محتوى مزعج");
  await expect(entry).toContainText("بلاغات متكررة");
  await expect(entry).toContainText(modEmail);
  await expect(entry).toContainText("ما زال موقوفًا");
  await expect(mod.page.getByTestId("reinstate-form")).toBeVisible();
  await expectNoHorizontalScroll(mod.page);

  // --- The member's session is gone and sign-in is refused.
  await reporter.page.goto("/profile");
  await expect(reporter.page).toHaveURL(/\/sign-in/);
  await signIn(reporter.page, member);
  await expect(
    reporter.page.getByRole("alert").filter({ hasText: "هذا الحساب موقوف" }),
  ).toBeVisible();
  await expect(reporter.page).toHaveURL(/\/sign-in$/);
  await expectNoHorizontalScroll(reporter.page);

  // --- Reinstate; sign-in works again.
  await mod.page.getByLabel("سبب إعادة التفعيل").selectOption({
    label: "قُبل الاعتراض",
  });
  await mod.page.getByRole("button", { name: "إعادة تفعيل الحساب" }).click();
  await expect(
    mod.page.getByRole("status").filter({ hasText: "تمت إعادة تفعيل الحساب" }),
  ).toBeVisible();
  await expect(mod.page.getByTestId("account-status")).toHaveText("نشط");
  await expect(mod.page.getByTestId("history-entry")).toContainText(
    "قُبل الاعتراض",
  );
  await expect(mod.page.getByTestId("suspend-form")).toBeVisible();
  await expectNoHorizontalScroll(mod.page);
  await signIn(reporter.page, member);
  await expect(reporter.page).toHaveURL(/\/account$/);

  expect(csp).toEqual([]);
  expect(modCsp).toEqual([]);
  expect(visitorCsp).toEqual([]);
  expect(reporterCsp).toEqual([]);
  await mod.context.close();
  await visitor.context.close();
  await reporter.context.close();
});
