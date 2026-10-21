import { describe, expect, it } from "vitest";
import {
  isJobName,
  JOB_NAMES,
  JOBS,
  parsePayload,
  safeParsePayload,
} from "./registry";

const ID = "6f1c9a52-3d4e-4b8a-9c1d-2e3f4a5b6c7d";

describe("job registry", () => {
  it("declares each dead-letter queue before the queue that uses it", () => {
    for (const [index, name] of JOB_NAMES.entries()) {
      const queue = JOBS[name].queue as { deadLetter?: string };
      if (!queue.deadLetter) continue;
      expect(isJobName(queue.deadLetter)).toBe(true);
      expect(JOB_NAMES.indexOf(queue.deadLetter as never)).toBeLessThan(index);
    }
  });

  it("uses names pg-boss accepts", () => {
    for (const name of JOB_NAMES) expect(name).toMatch(/^[\w.\-/]+$/);
  });

  it("retries upload processing with backoff and a dead letter", () => {
    expect(JOBS["upload.process"].queue).toMatchObject({
      retryBackoff: true,
      deadLetter: "upload.process.dead",
    });
    expect(JOBS["upload.process"].queue.retryLimit).toBeGreaterThan(0);
  });

  it.each(["upload.process", "upload.process.dead"] as const)(
    "%s accepts exactly an upload id",
    (name) => {
      expect(parsePayload(name, { uploadId: ID })).toEqual({ uploadId: ID });
      expect(safeParsePayload(name, { uploadId: ID })).toEqual({
        uploadId: ID,
      });
    },
  );

  it.each([
    ["missing id", {}],
    ["not a uuid", { uploadId: "../../etc/passwd" }],
    ["a number", { uploadId: 42 }],
    [
      "extra fields (no personal data in payloads)",
      { uploadId: ID, email: "a@b.test" },
    ],
    ["null", null],
    ["a string", ID],
  ])("upload.process rejects %s", (_label, data) => {
    expect(() => parsePayload("upload.process", data)).toThrow();
    expect(safeParsePayload("upload.process", data)).toBeNull();
  });

  it("knows its own names only", () => {
    expect(isJobName("upload.process")).toBe(true);
    expect(isJobName("toString")).toBe(false);
    expect(isJobName("email.send")).toBe(false);
  });
});
