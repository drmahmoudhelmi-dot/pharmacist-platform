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

// Job applications (ADR-007) in Arabic at 360 px. An employer publishes a job
// (first posts go through a moderator). An applicant without a profile is sent
// to /profile, then applies with a note and the phone shared and sees it on
// /applications. The employer opens the application (snapshot, phone, note),
// moves it to under review and shortlisted; the applicant sees that and
// withdraws. A third user gets 404 on the employer's page.

const exec = promisify(execFile);

// Own sign-up budget: the benchmarking range (198.18.0.0/15) is used by no
// other spec (the documentation ranges are taken, see jobs.spec.ts).
function clientIp() {
  return `198.18.0.${1 + Math.floor(Math.random() * 254)}`;
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

test("apply with a shared phone, get shortlisted, withdraw (360px)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const csp = watchCsp(page);
  const stamp = `A${Date.now()}`;
  const title = `صيدلي مبيعات ${stamp}`;
  const orgName = "صيدلية الطلبات";
  const phoneE164 = "+201155501234";

  // --- Employer: organization and a job.
  const owner = uniqueEmail("app-owner");
  await signUpAndVerify(page, owner);
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/organizations");
  await page.getByLabel("اسم المنشأة").fill(orgName);
  await page.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await page.getByRole("button", { name: "إنشاء المنشأة" }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}\/?$/);
  await page.getByRole("link", { name: "وظائف المنشأة" }).click();
  await page.getByRole("link", { name: "وظيفة جديدة" }).first().click();
  await page.getByLabel("عنوان الوظيفة").fill(title);
  await page.getByLabel("نوع الوظيفة").selectOption({ label: "صيدلي" });
  await page.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await page
    .getByLabel("وصف الوظيفة")
    .fill(
      "مطلوب صيدلي للعمل في صيدلية بالدقي بدوام كامل، مع الالتزام بالمواعيد والتعامل الجيد مع العملاء.",
    );
  await page.getByLabel("الحد الأدنى لسنوات الخبرة").fill("١");
  await page.getByRole("checkbox", { name: "صيدلي" }).check();
  await page.getByRole("button", { name: "حفظ المسودة" }).click();
  await expect(page).toHaveURL(/\/manage\/jobs\/[0-9a-f-]{36}$/);
  const jobId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("button", { name: "إرسال للنشر" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("قيد المراجعة");

  // --- Moderator publishes it.
  const mod = await newClient(browser, baseURL);
  const modCsp = watchCsp(mod.page);
  await becomeModerator(mod.page, uniqueEmail("app-moderator"));
  await mod.page.goto(`/staff/jobs/${jobId}`);
  await mod.page.getByRole("radio", { name: "موافقة ونشر" }).check();
  await mod.page.getByRole("button", { name: "تسجيل القرار" }).click();
  await mod.page.getByRole("button", { name: "تأكيد الموافقة" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/jobs$/);
  await mod.context.close();

  // --- Applicant without a profile is sent to the profile.
  const applicant = await newClient(browser, baseURL);
  const ap = applicant.page;
  const apCsp = watchCsp(ap);
  const applicantEmail = uniqueEmail("app-applicant");
  await signUpAndVerify(ap, applicantEmail);
  await signIn(ap, applicantEmail);
  await expect(ap).toHaveURL(/\/account$/);
  await ap.goto(`/jobs/${jobId}`);
  await expect(ap.getByRole("heading", { level: 1 })).toHaveText(title);
  const section = ap.getByTestId("apply-section");
  await expect(section).toHaveAttribute("data-state", "noProfile");
  await expect(section).toContainText("ملفك المهني هو ما يراه صاحب العمل");
  await expectNoHorizontalScroll(ap);
  await section.getByRole("link", { name: "إنشاء ملفي المهني" }).click();
  await expect(ap).toHaveURL(/\/profile$/);

  // A profile with a phone in the private details.
  await ap.getByLabel("الاسم الظاهر").fill("سارة المتقدمة");
  await ap.getByLabel("المرحلة المهنية").selectOption({ label: "صيدلي" });
  await ap.getByLabel("سنوات الخبرة").fill("٣");
  await ap.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await ap.getByRole("button", { name: "حفظ الملف" }).click();
  await expect(
    ap.getByRole("status").filter({ hasText: "تم حفظ ملفك." }),
  ).toBeVisible();
  const details = ap.getByRole("region", { name: /بيانات خاصة/ });
  await details.getByLabel("رقم الموبايل").fill("٠١١٥٥٥٠١٢٣٤");
  await details.getByRole("button", { name: "حفظ البيانات الخاصة" }).click();
  await expect(
    ap.getByRole("status").filter({ hasText: "تم حفظ بياناتك الخاصة." }),
  ).toBeVisible();

  // --- Apply, sharing the phone.
  await ap.goto(`/jobs/${jobId}`);
  await expect(section).toHaveAttribute("data-state", "open");
  await expect(section.getByTestId("share-explainer")).toContainText(
    "بريدك الإلكتروني لا يُعرض له أبدًا",
  );
  await expectNoHorizontalScroll(ap);
  await ap
    .getByLabel("رسالة قصيرة لصاحب العمل")
    .fill("لدي خبرة في خدمة العملاء وأستطيع البدء فورًا.");
  await ap.getByLabel("أشارك رقم موبايلي مع صاحب العمل").check();
  await ap.getByRole("button", { name: "تقديم الطلب" }).click();
  await expect(section).toHaveAttribute("data-state", "applied");
  await expect(section).toContainText("سبق أن تقدّمت إلى هذه الوظيفة");
  await expect(section.getByTestId("application-status")).toHaveText(
    "تم التقديم",
  );

  await section.getByRole("link", { name: "عرض تقديماتي" }).click();
  await expect(ap).toHaveURL(/\/applications$/);
  const mine = ap.getByTestId("application-item");
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(title);
  await expect(mine).toContainText(orgName);
  await expect(mine.getByTestId("application-status")).toHaveText("تم التقديم");
  await expectNoHorizontalScroll(ap);

  // --- Employer: list, then the application.
  await page.goto(`/manage/jobs/${jobId}`);
  const link = page.getByTestId("job-applications-link");
  await expect(link).toContainText("الطلبات المقدَّمة (١)");
  await link.click();
  await expect(page).toHaveURL(
    new RegExp(`/manage/jobs/${jobId}/applications$`),
  );
  const item = page.getByTestId("application-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("سارة المتقدمة");
  await expect(item).toContainText("صيدلي");
  await expect(item).toContainText("تم التقديم");
  await expectNoHorizontalScroll(page);
  await item.click();
  await expect(page).toHaveURL(/\/manage\/applications\/[0-9a-f-]{36}$/);
  const applicationPath = new URL(page.url()).pathname;
  await expect(page.getByTestId("applicant-name")).toHaveText("سارة المتقدمة");
  const phone = page.getByTestId("applicant-phone");
  await expect(phone).toHaveText(phoneE164);
  await expect(phone).toHaveAttribute("dir", "ltr");
  await expect(phone).toHaveAttribute("href", `tel:${phoneE164}`);
  await expect(page.getByTestId("applicant-note")).toContainText(
    "أستطيع البدء فورًا",
  );
  await expect(page.getByTestId("applicant-snapshot")).not.toContainText(
    applicantEmail,
  );
  await expectNoHorizontalScroll(page);

  // Rejecting asks first; cancel leaves the status as it was.
  await page.getByRole("button", { name: "رفض الطلب" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "لا يمكن التراجع" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "إلغاء" }).click();
  await expect(page.getByTestId("application-status")).toHaveText("تم التقديم");

  await page.getByRole("button", { name: "بدء المراجعة" }).click();
  await expect(page.getByTestId("application-status")).toHaveText(
    "قيد المراجعة",
  );
  await page
    .getByRole("button", { name: "إضافة إلى القائمة المختصرة" })
    .click();
  await expect(page.getByTestId("application-status")).toHaveText(
    "في القائمة المختصرة",
  );
  // From the shortlist only accept and reject remain.
  await expect(page.getByRole("button", { name: "بدء المراجعة" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "قبول الطلب" })).toBeVisible();

  // --- Applicant sees it and withdraws, after confirming.
  await ap.goto("/applications");
  await expect(
    ap.getByTestId("application-item").getByTestId("application-status"),
  ).toHaveText("في القائمة المختصرة");
  await ap.getByRole("button", { name: "سحب الطلب" }).click();
  await expect(ap.getByText("هل تريد سحب طلبك؟")).toBeVisible();
  await ap.getByRole("button", { name: "نعم، اسحب الطلب" }).click();
  await expect(
    ap.getByTestId("application-item").getByTestId("application-status"),
  ).toHaveText("تم السحب");
  await expect(ap.getByRole("button", { name: "سحب الطلب" })).toHaveCount(0);
  await expectNoHorizontalScroll(ap);

  // The employer sees the withdrawal and has no moves left.
  await page.goto(applicationPath);
  await expect(page.getByTestId("application-status")).toHaveText("تم السحب");
  await expect(page.getByTestId("move-buttons")).toContainText(
    "لا توجد إجراءات أخرى",
  );
  // Withdrawal redacts what was shared: no phone, no note, no profile.
  await expect(page.getByTestId("application-withdrawn")).toBeVisible();
  await expect(page.getByTestId("applicant-phone")).toHaveCount(0);
  expect(await page.content()).not.toContain(phoneE164);

  // --- A third user cannot open the employer's page; neither can the applicant.
  const third = await newClient(browser, baseURL);
  const thirdEmail = uniqueEmail("app-third");
  await signUpAndVerify(third.page, thirdEmail);
  await signIn(third.page, thirdEmail);
  await expect(third.page).toHaveURL(/\/account$/);
  expect((await third.page.goto(applicationPath))?.status()).toBe(404);
  expect((await ap.goto(applicationPath))?.status()).toBe(404);
  expect(
    (await third.page.goto(`/manage/jobs/${jobId}/applications`))?.status(),
  ).toBe(404);
  await third.context.close();

  expect(csp).toEqual([]);
  expect(modCsp).toEqual([]);
  expect(apCsp).toEqual([]);
  await applicant.context.close();
});
