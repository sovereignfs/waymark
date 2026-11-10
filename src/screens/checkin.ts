/**
 * Where the check-in sheet is (DESIGN.md §20.3): **it opens over any page, and it is in the address** (`?checkin=new`, and later `&t=` and `&item=` from a trip), so that a link opens it, the back button closes it,
 * and closing it puts the person back on the page they were on, with the rest of their query as it was. Pure, so that what a stray or hostile query does is tested with no browser.
 */
export const CHECKIN_PARAM = 'checkin';
export const CHECKIN_VALUE = 'new';

export const EDIT_VALUE = 'edit';
export const OF_PARAM = 'of';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What a query asks the sheet for: `checkin=new` to check in, or `checkin=edit&of=<id>` to change that check-in (9.4). **Exactly these**: anything else, an id that is not an id included, asks for nothing.
 */
export type CheckInMode = { readonly mode: 'new' } | { readonly mode: 'edit'; readonly id: string };
export function checkInMode(search: string | URLSearchParams): CheckInMode | undefined {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const asked = params.get(CHECKIN_PARAM);
  if (asked === CHECKIN_VALUE) return { mode: 'new' };
  const id = params.get(OF_PARAM) ?? '';
  return asked === EDIT_VALUE && ID.test(id) ? { mode: 'edit', id } : undefined;
}

/** Whether a query asks for the sheet at all. */
export function isCheckInOpen(search: string | URLSearchParams): boolean {
  return checkInMode(search) !== undefined;
}

const withQuery = (pathname: string, params: URLSearchParams): string => {
  const query = params.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
};

/** The address that opens the sheet over this page: the same path and query, with `checkin=new` (or `checkin=edit&of=<id>`) added or put right. */
export function checkInHref(
  pathname: string,
  search: string | URLSearchParams = '',
  mode: CheckInMode = { mode: 'new' },
): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  params.delete(OF_PARAM);
  if (mode.mode === 'edit') {
    params.set(CHECKIN_PARAM, EDIT_VALUE);
    params.set(OF_PARAM, mode.id);
  } else params.set(CHECKIN_PARAM, CHECKIN_VALUE);
  return withQuery(pathname, params);
}

/** The address that closes it: the same path and query without `checkin`. */
export function closedHref(pathname: string, search: string | URLSearchParams = ''): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  params.delete(CHECKIN_PARAM);
  params.delete(OF_PARAM);
  return withQuery(pathname, params);
}

/**
 * Whether a key press is the person asking to check in: `C`, with no modifier (Ctrl, Cmd and Alt are the browser's and the system's), **not while they are typing** (in a field, a text area, a select or
 * anything editable), and not when something else has already taken the key. The shortcut is a convenience: _Check in_ is also a link in the sidebar and the drawer.
 */
export function isCheckInKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  repeat?: boolean;
  /** What the key was pressed at: an element, as the browser gives it (or anything, in a test). */
  target: unknown;
}): boolean {
  if (event.key !== 'c' && event.key !== 'C') return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.repeat)
    return false;
  const target = event.target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  } | null;
  if (!target) return true;
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
  if (target.isContentEditable) return false;
  // An element inside an editable region, or one that is a text box by role.
  if (
    typeof target.closest === 'function' &&
    target.closest('[contenteditable="true"], [role="textbox"], [role="combobox"]')
  )
    return false;
  return true;
}
