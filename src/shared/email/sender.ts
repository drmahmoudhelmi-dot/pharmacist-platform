/** A fully rendered message. `text` is always present for clients without HTML. */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** BCP 47 tag of the body language, sent as Content-Language. */
  language: "ar" | "en";
};

/**
 * Provider boundary for outgoing email (ADR-001: provider adapters behind an
 * interface). Implementations must never log the message body: auth emails
 * carry single-use links.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
