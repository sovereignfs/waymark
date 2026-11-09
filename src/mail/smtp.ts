import { createTransport } from 'nodemailer';
import type { MailSettings, Mailer } from './mailer';

/** The mailer over SMTP, with nodemailer. A failure to send is thrown as it is and carries nothing of the message, which holds a link that signs a person in. */
export function smtpMailer(settings: MailSettings): Mailer {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.user !== undefined
      ? { auth: { user: settings.user, pass: settings.password } }
      : {}),
    // A mail server that cannot be reached must not hold a sign-up open for long.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      await transport.sendMail({
        from: settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}
