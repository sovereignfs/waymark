/**
 * Which part of Settings an address asks for (DESIGN.md §21): `/settings?section=security`. Pure, so that what a stray or hostile address does is tested with no
 * browser. Only sections that exist can be asked for; an address that names another, or nothing, opens Profile. The other of §21 (Check-ins) is added with the task that fills it (10.3).
 */
export const SECTIONS = ['profile', 'security', 'notifications', 'data', 'device'] as const;
export type SettingsSection = (typeof SECTIONS)[number];

export function sectionOf(asked: string | undefined): SettingsSection {
  return (SECTIONS as readonly string[]).includes(asked ?? '')
    ? (asked as SettingsSection)
    : 'profile';
}

/** The first value of a search parameter, which is all one of ours is. */
export const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
