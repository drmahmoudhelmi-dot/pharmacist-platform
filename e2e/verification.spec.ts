import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import sharp from "sharp";
import {
  expectNoHorizontalScroll,
  freshTotp,
  PASSWORD,
  signIn,
  signUpAndVerify,
  uniqueEmail,
  watchCsp,
} from "./helpers";
import { latestLinkTo } from "./mailpit";
import {
  accessLogCounts,
  processUploads,
  sendQueuedVerificationEmails,
} from "./worker-helpers";

// Professional verification end to end (ADR-004, 4b), Arabic RTL at 360 px:
// a pharmacist submits three photos, a reviewer (TOTP + role granted by the
// operator CLI) approves and the badge appears on the profile; a student's
// request is rejected and the reason is shown. The worker is not part of the
// E2E run, so e2e/worker-helpers.ts runs its upload and email code in the test
// process (stub scanner). National ID numbers are random synthetic values.

const exec = promisify(execFile);

// Own sign-up budget (TEST-NET-1), as in profiles.spec.ts.
function clientIp() {
  return `192.0.2.${1 + Math.floor(Math.random() * 254)}`;
}

test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "x-forwarded-for": clientIp() } });

async function newClient(browser: Browser, baseURL: string | undefined) {
  const context: BrowserContext = await browser.newContext({
    baseURL,
    viewport: { width: 360, height: 780 },
    locale: "ar-EG",
    extraHTTPHeaders: { "x-forwarded-for": clientIp() },
  });
  return { context, page: await context.newPage() };
}

/** 14 digits: century 2, born 15 March 1990, Cairo (01), random serial. */
function syntheticNationalId(): string {
  const serial = String(Math.floor(Math.random() * 100_000)).padStart(5, "0");
  return `2900315${"01"}${serial}`;
}
const toArabicDigits = (value: string) =>
  value.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!);
const masked = (id: string) => `2**********${id.slice(11)}`;

async function photo(color: string) {
  return sharp({
    create: { width: 480, height: 300, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
}

/** Picks a photo for one document, processes it like the worker, waits for "ready". */
async function uploadDocument(page: Page, label: string, color: string) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST",
  );
  await page.getByLabel(label, { exact: true }).setInputFiles({
    name: "card.jpg",
    mimeType: "image/jpeg",
    buffer: await photo(color),
  });
  const created = await response;
  expect(created.status()).toBe(202);
  const { id } = (await created.json()) as { id: string };
  await processUploads([id]);
  await expect(
    page.getByTestId(/^document-/).filter({ hasText: label }),
  ).toHaveAttribute("data-state", "clean", { timeout: 15_000 });
}

/** A verification reviewer: TOTP on, role granted by the CLI, signed in with TOTP. */
async function becomeReviewer(page: Page, email: string) {
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
    "verification_reviewer",
  ]);
  expect(cli.stdout).toContain("Role granted");
  await page.goto("/sign-in");
  await signIn(page, email);
  await page.getByLabel("رمز التحقق").fill(await freshTotp(secret));
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(page).toHaveURL(/\/account$/);
}

async function openSubmission(page: Page, nationalId: string) {
  await page.goto("/staff/verification");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "طلبات التوثيق",
  );
  await page
    .getByTestId("queue-item")
    .filter({ hasText: masked(nationalId) })
    .first()
    .click();
  await expect(page).toHaveURL(/\/staff\/verification\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("review-status")).toHaveText("قيد المراجعة");
}

test("a pharmacist is verified by a reviewer and gets the badge; a student is rejected with a reason", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const csp = watchCsp(page);

  // --- The pharmacist prepares a profile and asks for verification. ---------
  const pharmacist = uniqueEmail("verify-pharmacist");
  await signUpAndVerify(page, pharmacist);
  await signIn(page, pharmacist);
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/profile");
  await page.getByLabel("الاسم الظاهر").fill("د. صيدلي الاختبار");
  await page.getByLabel("المرحلة المهنية").selectOption({ label: "صيدلي" });
  await page.getByLabel("سنوات الخبرة").fill("٤");
  await page.getByRole("button", { name: "حفظ الملف" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم حفظ ملفك." }),
  ).toBeVisible();
  await expect(page.getByTestId("profile-verification-state")).toHaveText(
    "غير موثّق",
  );

  await page.goto("/account");
  await page.getByRole("link", { name: "توثيق حسابي" }).click();
  await expect(page).toHaveURL(/\/verification$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("verification-state")).toHaveText("غير موثّق");
  await expect(
    page.getByText("صياغة مؤقتة بانتظار مراجعة المستشار القانوني"),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Client-side checks first: nothing filled in.
  await page.getByRole("button", { name: "إرسال طلب التوثيق" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "راجع الحقول المميزة" }),
  ).toBeVisible();
  await expect(page.getByText("يجب الموافقة للمتابعة.")).toBeVisible();

  // The legal name: Arabic only, at least three words; harakat are removed.
  const legalName = page.getByLabel("الاسم كما هو مكتوب في بطاقة الرقم القومي");
  await expect(legalName).toHaveAttribute("dir", "rtl");
  await legalName.fill("Sami Farid");
  await page.getByRole("button", { name: "إرسال طلب التوثيق" }).click();
  await expect(
    page.getByText(
      "اكتب الاسم بالحروف العربية فقط، بدون أرقام أو حروف إنجليزية.",
    ),
  ).toBeVisible();
  await legalName.fill("س\u064Eامي فريد عبد الحميد");

  const nationalId = syntheticNationalId();
  await page
    .getByLabel("الرقم القومي", { exact: true })
    .fill(toArabicDigits(nationalId));
  await page.getByLabel("رقم العضوية في النقابة").fill("٤٥٦٧٨");
  await uploadDocument(page, "البطاقة الشخصية (الوجه)", "#1b4332");
  await uploadDocument(page, "البطاقة الشخصية (الظهر)", "#2d6a4f");
  await uploadDocument(page, "كارنيه نقابة الصيادلة", "#40916c");
  await page.getByLabel("أوافق على ما سبق").check();
  await page.getByRole("button", { name: "إرسال طلب التوثيق" }).click();
  await expect(page.getByTestId("verification-state")).toHaveText(
    "قيد المراجعة",
  );
  await expect(page.getByTestId("national-id-masked")).toHaveText(
    masked(nationalId),
  );
  await expect(page.getByTestId("verification-form")).toHaveCount(0);
  // The full number is nowhere on the page.
  expect(await page.content()).not.toContain(nationalId);
  await expectNoHorizontalScroll(page);

  // The "received" email, sent by the worker's code.
  expect(await sendQueuedVerificationEmails()).toBeGreaterThanOrEqual(1);
  expect(
    new URL(await latestLinkTo(page.request, pharmacist, "استلمنا طلب التوثيق"))
      .pathname,
  ).toBe("/verification");

  // A regular member cannot reach the staff area or the document route.
  await page.goto("/staff/verification");
  await expect(page).toHaveURL(/\/account\?notice=staff_denied$/);

  // --- A reviewer approves. ----------------------------------------------------
  const { context: staffContext, page: staff } = await newClient(
    browser,
    baseURL,
  );
  const staffCsp = watchCsp(staff);
  await becomeReviewer(staff, uniqueEmail("verify-reviewer"));
  await staff.getByRole("link", { name: "منطقة فريق العمل" }).click();
  await staff.getByRole("link", { name: "طلبات التوثيق" }).click();
  await openSubmission(staff, nationalId);
  await expectNoHorizontalScroll(staff);
  // The legal name, normalized, above the claims and beside the photos.
  await expect(staff.getByTestId("review-legal-name")).toHaveText(
    "سامي فريد عبد الحميد",
  );
  await expect(staff.getByTestId("review-legal-name-compare")).toContainText(
    "سامي فريد عبد الحميد",
  );

  // The three photos load through the logged, signed-URL route.
  for (const kind of [
    "national_id_front",
    "national_id_back",
    "syndicate_card",
  ]) {
    const image = staff.getByTestId(`review-document-${kind}`);
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  }
  const documentId = (
    await staff
      .getByTestId("review-document-syndicate_card")
      .getAttribute("src")
  )
    ?.split("/")
    .pop();
  const direct = await staff.request.get(
    `/api/verification/documents/${documentId}`,
    {
      maxRedirects: 0,
      headers: { "sec-fetch-site": "same-origin" },
    },
  );
  expect(direct.status()).toBe(303);
  expect(direct.headers()["cache-control"]).toBe("no-store");
  // The submitter has no access to the route.
  expect(
    (
      await page.request.get(`/api/verification/documents/${documentId}`, {
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(404);

  // Masked until revealed; the reveal is logged.
  await expect(staff.getByTestId("review-national-id")).toHaveText(
    masked(nationalId),
  );
  await staff.getByRole("button", { name: "إظهار الرقم القومي" }).click();
  await expect(staff.getByTestId("review-national-id")).toHaveText(nationalId);

  await staff.getByLabel("موافقة (توثيق)").check();
  await expect(staff.getByLabel("السبب")).toHaveValue("documents_match");
  await staff.getByRole("button", { name: "تسجيل القرار" }).click();
  await expect(
    staff.getByText("ستتم الموافقة على الطلب وإبلاغ المستخدم"),
  ).toBeVisible();
  await staff.getByRole("button", { name: "تأكيد الموافقة" }).click();
  await expect(staff.getByTestId("decision-summary")).toContainText(
    "موافقة (توثيق)",
  );
  await expect(staff.getByTestId("review-status")).toHaveText("موثّق");
  // Decided: the photos are gone from the page.
  await expect(
    staff.getByTestId("review-document-national_id_front"),
  ).toHaveCount(0);

  const logged = await accessLogCounts(pharmacist);
  expect(logged.view).toBeGreaterThanOrEqual(4);
  expect(logged.reveal_national_id).toBe(1);

  // --- The pharmacist sees the result and the badge. ---------------------------
  await page.goto("/verification");
  await expect(page.getByTestId("verification-state")).toHaveText("موثّق");
  await sendQueuedVerificationEmails();
  await latestLinkTo(page.request, pharmacist, "تم توثيق حسابك");
  await page.goto("/profile");
  await expect(
    page
      .getByTestId("profile-verification-state")
      .getByTestId("verified-badge"),
  ).toHaveText("موثّق");
  await page.getByRole("link", { name: "عرض ملفي كما يراه الأعضاء" }).click();
  await expect(page).toHaveURL(/\/profiles\/[0-9a-f-]{36}$/);
  await expect(
    page.getByTestId("profile-view").getByTestId("verified-badge"),
  ).toHaveText("موثّق");
  // The legal name is for reviewers only, never on the profile.
  await expect(page.getByText("سامي فريد عبد الحميد")).toHaveCount(0);
  const profileUrl = page.url();

  // --- A student is rejected; the reason is shown. --------------------------------
  const { context: studentContext, page: student } = await newClient(
    browser,
    baseURL,
  );
  const studentEmail = uniqueEmail("verify-student");
  await signUpAndVerify(student, studentEmail);
  await signIn(student, studentEmail);
  await expect(student).toHaveURL(/\/account$/);
  // The pharmacist's profile shows the badge to other members too.
  await student.goto(profileUrl);
  await expect(
    student.getByTestId("profile-view").getByTestId("verified-badge"),
  ).toBeVisible();

  await student.goto("/verification");
  await student.getByLabel("طالب صيدلة").check();
  const studentId = syntheticNationalId();
  await student
    .getByLabel("الاسم كما هو مكتوب في بطاقة الرقم القومي")
    .fill("ليلى منير  حسن");
  await student.getByLabel("الرقم القومي", { exact: true }).fill(studentId);
  await student
    .getByRole("textbox", { name: "الجامعة" })
    .fill("جامعة الإسكندرية");
  await uploadDocument(student, "البطاقة الشخصية (الوجه)", "#003049");
  await uploadDocument(student, "البطاقة الشخصية (الظهر)", "#d62828");
  await uploadDocument(student, "كارنيه الكلية", "#f77f00");
  await student.getByLabel("أوافق على ما سبق").check();
  await student.getByRole("button", { name: "إرسال طلب التوثيق" }).click();
  await expect(student.getByTestId("verification-state")).toHaveText(
    "قيد المراجعة",
  );

  await openSubmission(staff, studentId);
  await staff.getByRole("radio", { name: "رفض" }).check();
  await staff
    .getByLabel("السبب")
    .selectOption({ label: "صورة مستند غير واضحة أو غير مقروءة." });
  await staff
    .getByLabel("ملاحظة داخلية (اختياري)")
    .fill("صورة الكارنيه مهزوزة");
  await staff.getByRole("button", { name: "تسجيل القرار" }).click();
  await staff.getByRole("button", { name: "تأكيد الرفض" }).click();
  await expect(staff.getByTestId("review-status")).toHaveText("مرفوض");

  await student.reload();
  await expect(student.getByTestId("verification-state")).toHaveText("مرفوض");
  await expect(student.getByTestId("rejection-reason")).toHaveText(
    "السبب: صورة مستند غير واضحة أو غير مقروءة.",
  );
  // The internal note stays with staff.
  await expect(student.getByText("مهزوزة")).toHaveCount(0);
  // A new request is possible right away.
  await expect(student.getByTestId("verification-form")).toBeVisible();
  await sendQueuedVerificationEmails();
  await latestLinkTo(student.request, studentEmail, "لم تتم الموافقة");

  expect(csp).toEqual([]);
  expect(staffCsp).toEqual([]);
  await staffContext.close();
  await studentContext.close();
});
