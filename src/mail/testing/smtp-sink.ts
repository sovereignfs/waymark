import { type Server, type Socket, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A mail server for a test: it listens on 127.0.0.1, says what an SMTP server says (no STARTTLS, no authentication offered), takes a message and keeps what
 * was said. Enough for nodemailer to speak to, so that the SMTP adapter is tested as it runs and not against a stand-in.
 */
export interface Received {
  readonly from: string;
  readonly to: string[];
  readonly data: string;
}

export class SmtpSink {
  readonly received: Received[] = [];
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static async start(): Promise<SmtpSink> {
    const received: Received[] = [];
    const holder: { sink?: SmtpSink } = {};
    const server = createServer((socket) => {
      holder.sink?.sockets.add(socket);
      socket.on('close', () => holder.sink?.sockets.delete(socket));
      socket.on('error', () => undefined);
      let from = '';
      let to: string[] = [];
      let data: string[] | undefined;
      let buffer = '';
      socket.write('220 sink ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (data) {
            if (line === '.') {
              holder.sink?.received.push({ from, to, data: data.join('\n') });
              received.push({ from, to, data: data.join('\n') });
              data = undefined;
              socket.write('250 queued\r\n');
            } else data.push(line.startsWith('..') ? line.slice(1) : line);
            continue;
          }
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO')) socket.write('250-sink\r\n250 8BITMIME\r\n');
          else if (upper.startsWith('HELO')) socket.write('250 sink\r\n');
          else if (upper.startsWith('MAIL FROM:')) {
            from = /<([^>]*)>/.exec(line)?.[1] ?? '';
            to = [];
            socket.write('250 ok\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            socket.write('250 ok\r\n');
          } else if (upper === 'DATA') {
            data = [];
            socket.write('354 go on\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 bye\r\n');
            socket.end();
          } else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sink = new SmtpSink(server, (server.address() as AddressInfo).port);
    holder.sink = sink;
    return sink;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
