import { createTransport } from "nodemailer";
import type { EmailMessage, EmailSender } from "./sender";

export type SmtpConfig = {
  host: string;
  port: number;
  from: string;
};

/**
 * SMTP sender (Mailpit locally). Port 465 uses implicit TLS; other ports
 * upgrade with STARTTLS when the server offers it. Production SMTP credentials
 * are not configured yet: the provider is an open product-owner decision.
 */
export function createSmtpSender(config: SmtpConfig): EmailSender {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    // Fail fast instead of holding a request open for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // Never let nodemailer write message contents to any log.
    logger: false,
    debug: false,
  });

  return {
    async send(message: EmailMessage) {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: { "Content-Language": message.language },
      });
    },
  };
}
