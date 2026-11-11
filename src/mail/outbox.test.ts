import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import type { Mailer, Message } from './mailer';
import { MemoryMailer } from './memory';
import {
  BACKOFF_MS,
  LEASE_MS,
  MAX_AGE_MS,
  MAX_ATTEMPTS,
  deleteMailOf,
  dropStale,
  enqueueMail,
  outboxMailer,
  sendDue,
} from './outbox';
import { smtpMailer } from './smtp';
import { SmtpSink } from './testing/smtp-sink';
import { resetMessage, verificationMessage } from './templates';

/** The mail outbox (DESIGN.md §17.2), on whichever database the leg runs on: sealed, sent once however many workers, tried again after a pause, given up on, and never in a log. */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);

let database: Database;
let close: () => Promise<void>;
let NOW = 1_800_000_000_000;
beforeAll(async () => {
  ({ database, close } = await makeStore());
});
afterAll(async () => close());
beforeEach(async () => {
  // Each test starts from an empty outbox.
  await dbAll(database, sql`DELETE FROM ${tbl()} RETURNING id`);
  NOW += 10 * 60_000;
});

const tbl = () => sql.raw(database.dialect === 'postgres' ? 'waymark.mail_outbox' : 'mail_outbox');
const deps = () => ({ database, sealer, now: () => NOW });
const message = (n: number, over: Partial<Message> = {}): Message => ({
  to: `person${n}@example.com`,
  subject: `Subject ${n}`,
  text: `Hello ${n}\n\nhttps://waymark.example/x/${n}\n`,
  ...over,
});
const queue = (n: number, accountId?: string) =>
  enqueueMail(database, sealer, NOW, { accountId, kind: 'notice', message: message(n) });
const rows = () =>
  dbAll<{ id: string; attempts: number | string; nextAttemptAt: number | string }>(
    database,
    sql`SELECT id, attempts, next_attempt_at AS "nextAttemptAt" FROM ${tbl()} ORDER BY id`,
  );

/** A mailer that fails for the first `failures` sends of each message, saying the address in its complaint, as a mail server does. */
function flaky(failures: number) {
  const sent: Message[] = [];
  const tried = new Map<string, number>();
  const mailer: Mailer = {
    async send(each) {
      const n = (tried.get(each.to) ?? 0) + 1;
      tried.set(each.to, n);
      if (n <= failures) throw new Error(`550 5.1.1 <${each.to}> user unknown ${each.subject}`);
      sent.push(each);
    },
  };
  return { mailer, sent };
}

describe(`queueing mail (${leg})`, () => {
  it('keeps the address and the message sealed: nothing of them is in a column or readable in the envelope', async () => {
    const id = await enqueueMail(database, sealer, NOW, {
      kind: 'notice',
      message: message(1, { to: 'zxqv.person@example.com', subject: 'Zxqv subject' }),
    });
    const raw = await dbAll<Record<string, unknown>>(
      database,
      sql`SELECT * FROM ${tbl()} WHERE id = ${id}`,
    );
    expect(Buffer.from(raw[0]?.sealed as Uint8Array).includes(Buffer.from('zxqv'))).toBe(false);
    expect(JSON.stringify({ ...raw[0], sealed: undefined }).toLowerCase()).not.toContain('zxqv');
    expect(raw[0]).toMatchObject({ kind: 'notice', account_id: null });
  });

  it('is in the transaction of the change: rolled back with it, nothing is sent', async () => {
    await expect(
      transaction(database, async (tx) => {
        await enqueueMail(tx, sealer, NOW, { kind: 'notice', message: message(2) });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await rows()).toEqual([]);
  });

  it('is what the sign-in library is given as a mailer: its verification and reset mail wait in the outbox, with a kind, and are not sent by the request', async () => {
    const mailer = outboxMailer(deps());
    await mailer.send(verificationMessage('Waymark', 'ada@example.com', 'https://w.example/v?t=1'));
    await mailer.send(resetMessage('Waymark', 'ada@example.com', 'https://w.example/r?t=2'));
    const kinds = await dbAll<{ kind: string }>(
      database,
      sql`SELECT kind FROM ${tbl()} ORDER BY kind`,
    );
    expect(kinds.map((row) => row.kind)).toEqual(['reset', 'verification']);
    // Sent later, with the HTML as well as the text, and the link in both.
    const out = new MemoryMailer();
    expect(await sendDue(deps(), out)).toEqual({ sent: 2, retry: 0, gaveUp: 0 });
    const verification = out.sent.find((each) => each.subject.startsWith('Confirm'));
    expect(verification?.text).toContain('https://w.example/v?t=1');
    expect(verification?.html).toContain('<a href="https://w.example/v?t=1">');
    expect(await rows()).toEqual([]);
  });
});

describe(`sending (${leg})`, () => {
  it('sends what is due once and deletes it, and a second pass finds nothing', async () => {
    for (const n of [1, 2, 3]) await queue(n);
    const out = new MemoryMailer();
    expect(await sendDue(deps(), out)).toEqual({ sent: 3, retry: 0, gaveUp: 0 });
    expect(out.sent.map((each) => each.to).sort()).toEqual([
      'person1@example.com',
      'person2@example.com',
      'person3@example.com',
    ]);
    expect(await rows()).toEqual([]);
    expect(await sendDue(deps(), out)).toEqual({ sent: 0, retry: 0, gaveUp: 0 });
    expect(out.sent).toHaveLength(3);
  });

  it('is once with two workers: forty messages and two workers that run at the same time send each exactly once', async () => {
    for (let n = 0; n < 40; n += 1) await queue(n);
    const [a, b] = [new MemoryMailer(), new MemoryMailer()];
    // Two workers, each in turn claiming as much as it can, until the outbox is empty.
    const worker = async (mailer: MemoryMailer) => {
      for (let pass = 0; pass < 10; pass += 1) await sendDue(deps(), mailer);
    };
    await Promise.all([worker(a), worker(b)]);
    const all = [...a.sent, ...b.sent].map((each) => each.to);
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
    expect(await rows()).toEqual([]);
  });

  it('does not take a message another worker holds, and takes it when the hold has ended', async () => {
    await queue(1);
    const slow = new MemoryMailer();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocked: Mailer = {
      async send(each) {
        await held;
        await slow.send(each);
      },
    };
    const first = sendDue(deps(), blocked);
    // The first worker holds it: another finds nothing, even though it is due.
    await vi.waitFor(async () => expect((await rows())[0]?.attempts).toBe(1));
    const other = new MemoryMailer();
    expect(await sendDue(deps(), other)).toEqual({ sent: 0, retry: 0, gaveUp: 0 });
    release();
    await first;
    expect(slow.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);

    // A worker that died holding one: after the lease, another sends it.
    await queue(2);
    const dead: Mailer = { send: () => new Promise(() => undefined) };
    void sendDue(deps(), dead);
    await vi.waitFor(async () => expect((await rows())[0]?.attempts).toBe(1));
    NOW += LEASE_MS + 1;
    expect(await sendDue(deps(), other)).toEqual({ sent: 1, retry: 0, gaveUp: 0 });
    expect(other.sent[0]?.to).toBe('person2@example.com');
  });
});

describe(`trying again (${leg})`, () => {
  it('keeps what did not go, until its pause is over, and sends it then', async () => {
    await queue(1);
    const { mailer, sent } = flaky(1);
    expect(await sendDue(deps(), mailer)).toEqual({ sent: 0, retry: 1, gaveUp: 0 });
    const [row] = await rows();
    expect(Number(row?.attempts)).toBe(1);
    expect(Number(row?.nextAttemptAt)).toBe(NOW + BACKOFF_MS[0]);
    // Not before the pause is over.
    NOW += BACKOFF_MS[0] - 1;
    expect(await sendDue(deps(), mailer)).toEqual({ sent: 0, retry: 0, gaveUp: 0 });
    NOW += 1;
    expect(await sendDue(deps(), mailer)).toEqual({ sent: 1, retry: 0, gaveUp: 0 });
    expect(sent).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  it('waits longer after each failure, and gives up after the last try, deleting the message', async () => {
    await queue(1);
    const { mailer } = flaky(100);
    const pauses: number[] = [];
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const before = NOW;
      expect(await sendDue(deps(), mailer)).toEqual({ sent: 0, retry: 1, gaveUp: 0 });
      pauses.push(Number((await rows())[0]?.nextAttemptAt) - before);
      NOW = Number((await rows())[0]?.nextAttemptAt);
    }
    expect(pauses).toEqual([...BACKOFF_MS]);
    expect(pauses).toEqual([...pauses].sort((x, y) => x - y));
    expect(await sendDue(deps(), mailer)).toEqual({ sent: 0, retry: 0, gaveUp: 1 });
    expect(await rows()).toEqual([]);
  });

  it('gives up on a message that is too old to be of use rather than sending a link a day old, and removes one nobody claimed', async () => {
    await queue(1);
    NOW += MAX_AGE_MS + 1;
    const { mailer } = flaky(100);
    expect(await sendDue(deps(), mailer)).toEqual({ sent: 0, retry: 0, gaveUp: 1 });
    await queue(2);
    NOW += MAX_AGE_MS + 1;
    expect(await dropStale(deps())).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('gives up on a message that cannot be opened, since no try would open it', async () => {
    const id = await queue(1);
    await dbAll(
      database,
      sql`UPDATE ${tbl()} SET sealed = ${Buffer.from('not an envelope')} WHERE id = ${id} RETURNING id`,
    );
    expect(await sendDue(deps(), new MemoryMailer())).toEqual({ sent: 0, retry: 0, gaveUp: 1 });
    expect(await rows()).toEqual([]);
  });
});

describe(`what is logged (${leg})`, () => {
  it('is nothing: not an address, a subject, a word of a message, nor the mail server’s complaint, which repeats the address', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      await queue(7);
      await queue(8);
      const { mailer } = flaky(1);
      await sendDue(deps(), mailer);
      NOW += BACKOFF_MS[0];
      await sendDue(deps(), mailer);
      await sendDue(deps(), mailer);
      const written = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
      expect(written).toBe('');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe(`a person’s mail (${leg})`, () => {
  it('is removed with the person and no one else’s', async () => {
    await queue(1, 'ada');
    await queue(2, 'ada');
    await queue(3, 'grace');
    await queue(4);
    expect(await deleteMailOf(database, 'ada')).toBe(2);
    expect(await deleteMailOf(database, 'ada')).toBe(0);
    expect(await rows()).toHaveLength(2);
  });
});

describe(`through a real SMTP server (${leg})`, () => {
  let sink: SmtpSink;
  beforeAll(async () => {
    sink = await SmtpSink.start();
  });
  afterAll(async () => sink.stop());

  it('sends a message once, with its text and its HTML, with two workers running', async () => {
    const mailer = smtpMailer({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: undefined,
      password: undefined,
      from: 'Waymark <waymark@example.com>',
    });
    await outboxMailer(deps()).send(
      verificationMessage('Waymark', 'ada.smtp@example.com', 'https://w.example/v?t=9&x=<y>'),
    );
    await Promise.all([sendDue(deps(), mailer), sendDue(deps(), mailer)]);
    const mine = sink.received.filter((each) => each.to.some((to) => to.includes('ada.smtp')));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toContain('text/plain');
    expect(mine[0]?.data).toContain('text/html');
    // Quoted-printable on the wire: soft line breaks and `=3D` are undone before the body is read.
    const body = (mine[0]?.data ?? '')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    expect(body).toContain('https://w.example/v?t=9&x=<y>');
    // In the HTML the same address is escaped, so what a person typed or a link held can never become markup.
    expect(body).toContain('&lt;y&gt;');
    expect(body).toContain('<a href="https://w.example/v?t=9&amp;x=&lt;y&gt;">');
    expect(await rows()).toEqual([]);
  });
});
