import { expect, type APIRequestContext } from "@playwright/test";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

/** Waits for the newest email to `to` in local Mailpit and returns its first link. */
export async function latestLinkTo(
  request: APIRequestContext,
  to: string,
  subjectIncludes: string,
): Promise<string> {
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        const search = await request.get(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        );
        const { messages } = (await search.json()) as {
          messages: { ID: string; Subject: string }[];
        };
        const match = messages.find((m) => m.Subject.includes(subjectIncludes));
        if (!match) return null;
        const detail = await request.get(
          `${MAILPIT}/api/v1/message/${match.ID}`,
        );
        const { Text } = (await detail.json()) as { Text: string };
        link = /https?:\/\/\S+/.exec(Text)?.[0] ?? null;
        return link;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  return link as unknown as string;
}
