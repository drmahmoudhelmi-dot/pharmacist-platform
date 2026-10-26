import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { totpFromSecret } from "../tests/integration/helpers/totp";
import {
  expectNoHorizontalScroll,
  PASSWORD,
  signIn,
  signUpAndVerify,
  uniqueEmail,
  watchCsp,
} from "./helpers";

// Jobs and moderation of first posts (ADR-006) in Arabic at 360 px: an owner
// creates an organization and a temporary job (a validation error first),
// sends it, and it goes to review because it is the organization's first
// post. A moderator (TOTP + role granted by the operator CLI) approves it from
// /staff/jobs. A signed-out visitor finds it on /jobs by a word of its title
// and opens it. The owner pauses it (public page 404), resumes it, closes it.

const exec = promisify(execFile);

// Own sign-up budget (TEST-NET-2), as in verification.spec.ts.
function clientIp() {
  return `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
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
  await page.getByLabel("رمز التحقق").fill(totpFromSecret(secret));
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
  await page.getByLabel("رمز التحقق").fill(totpFromSecret(secret));
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(page).toHaveURL(/\/account$/);
}

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

test("a first job is reviewed, published, found by a visitor, paused, resumed and closed (360px)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const csp = watchCsp(page);
  // A latin token in the title keeps the search unique across runs.
  const stamp = `T${Date.now()}`;
  const title = `صيدلي وردية ${stamp}`;

  // --- Owner: organization, then the jobs list.
  const owner = uniqueEmail("job-owner");
  await signUpAndVerify(page, owner);
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/organizations");
  await page.getByLabel("اسم المنشأة").fill("صيدلية الوظائف");
  await page.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await page.getByRole("button", { name: "إنشاء المنشأة" }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}$/);
  await page.getByRole("link", { name: "وظائف المنشأة" }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}\/jobs$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("jobs-empty")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // --- A draft: validation error first, then a temporary job.
  await page.getByRole("link", { name: "وظيفة جديدة" }).first().click();
  await expect(page).toHaveURL(/\/jobs\/new$/);
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "حفظ المسودة" }).click();
  await expect(page.getByText("هذا الحقل مطلوب.").first()).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "راجع الحقول المميزة" }),
  ).toBeVisible();

  await page.getByLabel("عنوان الوظيفة").fill(title);
  await page.getByLabel("نوع الوظيفة").selectOption({ label: "صيدلي" });
  await page.getByRole("radio", { name: "مؤقت" }).check();
  await page.getByLabel("تاريخ البدء").fill(isoDay(10));
  await page.getByLabel("تاريخ الانتهاء").fill(isoDay(5));
  await page.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await page.getByLabel("المنطقة أو الشارع").fill("الدقي");
  await page
    .getByLabel("وصف الوظيفة")
    .fill(
      "مطلوب صيدلي للعمل بالوردية الصباحية في صيدلية بالدقي، مع الالتزام بالمواعيد.",
    );
  await page.getByLabel("الحد الأدنى لسنوات الخبرة").fill("٢");
  await page.getByRole("checkbox", { name: "صيدلي" }).check();
  await page.getByLabel("الأجر الشهري من").fill("٥٠٠٠");
  await page.getByLabel("الأجر الشهري إلى").fill("٧٠٠٠");
  await page.getByRole("button", { name: "حفظ المسودة" }).click();
  // The end date before the start date is refused before anything is sent.
  await expect(page.getByText("تاريخ الانتهاء قبل تاريخ البدء.")).toBeVisible();
  await page.getByLabel("تاريخ الانتهاء").fill(isoDay(20));
  await page.getByRole("button", { name: "حفظ المسودة" }).click();
  await expect(page).toHaveURL(/\/manage\/jobs\/[0-9a-f-]{36}$/);
  const jobPath = new URL(page.url()).pathname;
  const jobId = jobPath.split("/").pop()!;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.getByTestId("job-status")).toHaveText("مسودة");
  await expectNoHorizontalScroll(page);

  // --- First post: goes to review, not live.
  await page.getByRole("button", { name: "إرسال للنشر" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "أُرسلت الوظيفة للمراجعة" }),
  ).toBeVisible();
  await expect(page.getByTestId("job-status")).toHaveText("قيد المراجعة");
  await expect(page.getByTestId("job-public-link")).toHaveCount(0);
  await expect(page.getByTestId("job-form")).toHaveCount(0);

  // --- Moderator approves from the queue.
  const mod = await newClient(browser, baseURL);
  const modCsp = watchCsp(mod.page);
  await becomeModerator(mod.page, uniqueEmail("job-moderator"));
  await mod.page.goto("/staff");
  await mod.page.getByRole("link", { name: "مراجعة الوظائف" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/jobs$/);
  await expectNoHorizontalScroll(mod.page);
  await mod.page.getByTestId("queue-item").filter({ hasText: stamp }).click();
  await expect(mod.page).toHaveURL(new RegExp(`/staff/jobs/${jobId}$`));
  await expect(mod.page.getByTestId("review-job-title")).toHaveText(title);
  await expect(mod.page.getByTestId("job-description")).toContainText(
    "الوردية الصباحية",
  );
  await expectNoHorizontalScroll(mod.page);
  // A decision without a choice is refused locally.
  await mod.page.getByRole("button", { name: "تسجيل القرار" }).click();
  await expect(mod.page.getByText("هذا الحقل مطلوب.")).toBeVisible();
  await mod.page.getByRole("radio", { name: "موافقة ونشر" }).check();
  await mod.page.getByRole("button", { name: "تسجيل القرار" }).click();
  await mod.page.getByRole("button", { name: "تأكيد الموافقة" }).click();
  await expect(mod.page).toHaveURL(/\/staff\/jobs$/);
  await expect(
    mod.page.getByTestId("queue-item").filter({ hasText: stamp }),
  ).toHaveCount(0);
  // A decided job is no longer reviewable.
  const decided = await mod.page.goto(`/staff/jobs/${jobId}`);
  expect(decided?.status()).toBe(404);

  // --- A signed-out visitor finds it.
  const visitor = await newClient(browser, baseURL);
  const visitorCsp = watchCsp(visitor.page);
  await visitor.page.goto("/");
  await visitor.page.getByRole("link", { name: "الوظائف" }).click();
  await expect(visitor.page).toHaveURL(/\/jobs$/);
  await expect(visitor.page.getByRole("heading", { level: 1 })).toHaveText(
    "وظائف الصيادلة",
  );
  await expectNoHorizontalScroll(visitor.page);
  await visitor.page.getByLabel("ابحث في الوظائف").fill(stamp);
  await visitor.page.getByRole("button", { name: "بحث" }).click();
  await expect(visitor.page).toHaveURL(/\/jobs\?.*q=/);
  const card = visitor.page.getByTestId("job-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(title);
  await expect(card).toContainText("صيدلية الوظائف");
  await expect(card).toContainText("الجيزة");
  await expect(card).toContainText("مؤقت");
  await expect(card).toContainText("٥٬٠٠٠");
  await expect(card.getByTestId("verified-poster")).toHaveCount(0);
  await expect(
    visitor.page.getByText("لم تراجعها المنصة").first(),
  ).toBeVisible();
  await expectNoHorizontalScroll(visitor.page);
  // A search with no match shows the empty state.
  await visitor.page.goto(`/jobs?q=${stamp}zzz`);
  await expect(visitor.page.getByTestId("jobs-empty")).toBeVisible();

  await visitor.page.goto(`/jobs?q=${stamp}`);
  await visitor.page.getByTestId("job-card").click();
  await expect(visitor.page).toHaveURL(new RegExp(`/jobs/${jobId}$`));
  await expect(visitor.page.getByRole("heading", { level: 1 })).toHaveText(
    title,
  );
  await expect(visitor.page.getByTestId("job-organization")).toContainText(
    "صيدلية الوظائف",
  );
  await expect(visitor.page.getByTestId("job-description")).toContainText(
    "الوردية الصباحية",
  );
  await expectNoHorizontalScroll(visitor.page);

  // --- Owner pauses: the public page disappears; resume brings it back.
  await page.reload();
  await expect(page.getByTestId("job-status")).toHaveText("منشورة");
  await expect(page.getByTestId("job-public-link")).toBeVisible();
  await page.getByRole("button", { name: "إيقاف مؤقت" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("متوقفة مؤقتًا");
  expect((await visitor.page.goto(`/jobs/${jobId}`))?.status()).toBe(404);
  await page.getByRole("button", { name: "استئناف النشر" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("منشورة");
  expect((await visitor.page.goto(`/jobs/${jobId}`))?.status()).toBe(200);

  // --- Close, after confirming.
  await page.getByRole("button", { name: "إغلاق الوظيفة" }).click();
  await page.getByRole("button", { name: "نعم، أغلق الوظيفة" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("مغلقة");
  expect((await visitor.page.goto(`/jobs/${jobId}`))?.status()).toBe(404);
  await visitor.page.goto(`/jobs?q=${stamp}`);
  await expect(visitor.page.getByTestId("jobs-empty")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // A closed job can be copied into a new draft.
  await page.getByRole("button", { name: "إنشاء نسخة جديدة" }).click();
  await page.waitForURL(
    (url) =>
      url.pathname !== jobPath &&
      /\/manage\/jobs\/[0-9a-f-]{36}$/.test(url.pathname),
  );
  await expect(page.getByTestId("job-status")).toHaveText("مسودة");

  // Someone outside the organization gets the same 404 as a missing job.
  expect((await mod.page.goto(jobPath))?.status()).toBe(404);

  expect(csp).toEqual([]);
  expect(modCsp).toEqual([]);
  expect(visitorCsp).toEqual([]);
  await mod.context.close();
  await visitor.context.close();
});
