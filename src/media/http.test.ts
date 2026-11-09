import { describe, expect, it } from 'vitest';
import { bodyOf, fileHeaders, refusal, uploadKind } from './http';
import { MAX_FILE_BYTES, SENTENCES, type Refusal } from './service';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/media', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit);

describe('reading an upload', () => {
  it('reads a body that is within the limit, and an empty one', async () => {
    expect((await bodyOf(post(new Uint8Array([1, 2, 3])))) as Uint8Array).toHaveLength(3);
    expect((await bodyOf(post(null))) as Uint8Array).toHaveLength(0);
  });

  it('refuses a body whose length says it is too big, without reading it', async () => {
    const request = post('x', { 'content-length': String(MAX_FILE_BYTES + 1) });
    expect(await bodyOf(request)).toBe('too_big');
    expect(request.bodyUsed).toBe(false);
  });

  it('cuts off a body that is too big whatever it said its length was', async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (sent > 100 * 1024 * 1024) controller.close();
      },
    });
    expect(await bodyOf(post(stream, { 'content-length': '10' }))).toBe('too_big');
    // It stopped at the limit and did not read on to a hundred megabytes.
    expect(sent).toBeLessThanOrEqual(MAX_FILE_BYTES + 3 * 1024 * 1024);
  });
});

describe('what a person uploads', () => {
  it('is a photo, an attachment or an import, and never a thumbnail or anything else', () => {
    expect(['photo', 'attachment', 'import'].map(uploadKind)).toEqual([
      'photo',
      'attachment',
      'import',
    ]);
    for (const value of ['thumb', 'PHOTO', '', null, 'avatar', '../photo'])
      expect(uploadKind(value)).toBeUndefined();
  });
});

describe('what a file is served with', () => {
  it('has the type it was stored as, is never sniffed, is private, and may run nothing', () => {
    const headers = fileHeaders('image/webp');
    expect(headers['content-type']).toBe('image/webp');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toContain('private');
    expect(headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(headers['content-disposition']).toBe('inline');
    expect(fileHeaders('application/pdf')['content-disposition']).toBe('inline');
    expect(fileHeaders('application/zip')['content-disposition']).toBe('attachment');
  });
});

describe('what a refusal says', () => {
  it('is a status, a code and a sentence for each reason, and nothing of the file; an id that is someone else’s is not found', async () => {
    for (const reason of Object.keys(SENTENCES) as Refusal[]) {
      const response = refusal(reason);
      if (reason === 'id_taken') {
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('');
        continue;
      }
      expect(response.status, reason).toBeGreaterThanOrEqual(400);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.message).toBe(SENTENCES[reason]);
      expect(body.code).toBe(reason.toUpperCase());
    }
  });
});
