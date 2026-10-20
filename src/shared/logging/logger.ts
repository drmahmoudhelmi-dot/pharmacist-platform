import pino, { type Logger, type LoggerOptions } from "pino";

const REDACTED_KEYS = [
  "password",
  "token",
  "otp",
  "nationalId",
  "email",
  "phone",
];

// Covers the key at the top level and one and two levels deep, plus request headers.
export const redactPaths = [
  ...REDACTED_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
];

export function createLogger(
  options: LoggerOptions = {},
  destination?: pino.DestinationStream,
): Logger {
  const config: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: redactPaths, censor: "[redacted]" },
    ...options,
  };
  return destination ? pino(config, destination) : pino(config);
}

export const logger = createLogger();
