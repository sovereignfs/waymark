/**
 * Sending mail (DESIGN.md §19.1), behind one small interface so that the app is tested against a mailer a test can read and runs against SMTP. **Mail is
 * optional:** with no `WAYMARK_SMTP_HOST` there is no mailer, an address is not verified and a forgotten password is not reset by mail, and no screen or endpoint
 * offers either. The text of a message is made by `templates.ts` and holds a link and nothing else of the account.
 */
export interface Message {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: Message): Promise<void>;
}

/** What the server was told about mail: where to send and as whom. */
export interface MailSettings {
  readonly host: string;
  readonly port: number;
  /** `true` for the SMTPS port (465), where the connection is encrypted from the start; otherwise the connection is upgraded when the server offers it. */
  readonly secure: boolean;
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly from: string;
}
