import type { Mailer, Message } from './mailer';

/** A mailer that keeps what it was asked to send, for a test to read. */
export class MemoryMailer implements Mailer {
  readonly sent: Message[] = [];
  /** Makes the next sends fail, to see what the app does when mail does not go. */
  failNext = 0;

  async send(message: Message): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('the mail server did not take it');
    }
    this.sent.push(message);
  }

  /** The link in the last message to `to`: what a person clicks. */
  linkTo(to: string): string | undefined {
    const last = [...this.sent]
      .reverse()
      .find((message) => message.to.toLowerCase() === to.toLowerCase());
    return last ? /https?:\/\/\S+/.exec(last.text)?.[0] : undefined;
  }
}
