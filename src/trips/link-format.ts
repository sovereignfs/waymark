/**
 * What a trip's link is allowed to be (DESIGN.md §10.7), pure. **An `https` address and nothing else**: `http:`, `javascript:`, `data:`, `file:` and every other scheme are refused, and so is an address that carries a username or a
 * password, one with no host, one with a space or a control character in it, and one that is too long. The address is kept as the URL parser writes it (the host in lower case, escapes made plain), so that two spellings of one address are one.
 * **Nothing here, or anywhere in `src/trips/links.ts`, fetches an address**: a link is a thing a person opens in their own browser. A problem is a sentence that repeats nothing typed.
 */
export const LINK_KINDS = ['tally', 'other'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
/** At most this many links on a trip (DESIGN.md §10.7). */
export const MAX_LINKS = 10;
export const LINK_TITLE_MAX = 120;
export const LINK_URL_MAX = 2000;
/** What a link of kind `tally` is called when its title is left out. */
export const TALLY_TITLE = 'Expenses in Tally';

export type LinkCheck<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly sentence: string };

const bad = (sentence: string): { ok: false; sentence: string } => ({ ok: false, sentence });

/** The address as it is kept, or why not. */
export function cleanLinkUrl(input: unknown): LinkCheck<string> {
  if (typeof input !== 'string') return bad('A link is a web address starting with https://.');
  const text = input.trim();
  if (text === '' || text.length > LINK_URL_MAX)
    return bad(
      `A link is a web address of at most ${LINK_URL_MAX} characters starting with https://.`,
    );
  // Spaces and control characters are not part of an address, and the parser would quietly drop some of them.
  if (
    [...text].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  )
    return bad('A link is a web address starting with https://.');
  // Written out as the address it is: the parser is lenient with a scheme and a missing slash (`https:example.org`), and a link is only what the person typed, kept tidy.
  if (!/^https:\/\/[^/\\?#]/i.test(text)) return bad('A link has to start with https://.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return bad('A link is a web address starting with https://.');
  }
  if (url.hostname === '') return bad('A link is a web address starting with https://.');
  if (url.username !== '' || url.password !== '')
    return bad('A link cannot carry a name or password in its address.');
  return { ok: true, value: url.href };
}

export interface LinkFields {
  readonly kind: LinkKind;
  readonly title: string;
  readonly url: string;
}

/** A whole link from what was given: the kind (`other` when none), a title (one line, up to 120 characters; left out, a Tally link is called what it is) and an `https` address. */
export function checkLink(input: {
  kind?: unknown;
  title?: unknown;
  url?: unknown;
}): LinkCheck<LinkFields> {
  const kind = input.kind === undefined || input.kind === null ? 'other' : input.kind;
  if (typeof kind !== 'string' || !(LINK_KINDS as readonly string[]).includes(kind))
    return bad(`A link's kind is one of ${LINK_KINDS.join(', ')}.`);
  const url = cleanLinkUrl(input.url);
  if (!url.ok) return url;
  let title: string;
  if (input.title === undefined || input.title === null || input.title === '') {
    if (kind !== 'tally') return bad('A link needs a title.');
    title = TALLY_TITLE;
  } else {
    if (typeof input.title !== 'string') return bad('A link needs a title.');
    const trimmed = input.title.trim();
    if (trimmed === '' || trimmed.length > LINK_TITLE_MAX || /[\r\n]/.test(trimmed))
      return bad(`A link's title is 1 to ${LINK_TITLE_MAX} characters on one line.`);
    title = trimmed;
  }
  return { ok: true, value: { kind: kind as LinkKind, title, url: url.value } };
}
