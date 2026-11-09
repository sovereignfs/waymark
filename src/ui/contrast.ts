/**
 * The colour of text to put on a colour a person chose (DESIGN.md §17.7): a board's colour, a label's. It is **data and not a token**, so it cannot be
 * given a text colour of the design system's; this says whether black or white reads on it, by the WCAG relative luminance. Pure.
 */
const channel = (value: number): number => {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance of `#rrggbb`, from 0 (black) to 1 (white); 0 for anything that is not a colour. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return 0;
  const [r, g, b] = [match[1], match[2], match[3]].map((part) =>
    channel(parseInt(part ?? '0', 16)),
  );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The contrast ratio of two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** `#000000` or `#ffffff`: whichever has the greater contrast with `background`. */
export function readableOn(background: string): '#000000' | '#ffffff' {
  return contrast(background, '#000000') >= contrast(background, '#ffffff') ? '#000000' : '#ffffff';
}
