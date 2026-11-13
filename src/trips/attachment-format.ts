/**
 * What an attachment's kind and title may be (DESIGN.md §10.6), in a file of its own with nothing server-side in it, so that a screen can use the same list the server does. `attachments.ts` re-exports them.
 */
export const ATTACHMENT_KINDS = ['receipt', 'booking', 'accommodation', 'ticket', 'other'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export const ATTACHMENT_TITLE_MAX = 200;
