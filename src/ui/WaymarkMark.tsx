/**
 * Waymark's mark: a map pin with its dot cut out, in one path, in the colour of the text around it (`currentColor`), so that it follows the theme. The
 * view box is the shape's own bounds. It says nothing to a screen reader unless it is given a `label`: beside the name, the name says it.
 *
 * The same shape is the app's icons (`public/icons/`), as a light mark on the dark tile.
 */
export const MARK_PATH =
  'M256 96C190 96 138 148 138 214C138 296 214 366 256 424C298 366 374 296 374 214C374 148 322 96 256 96ZM256 168a46 46 0 1 1 0 92a46 46 0 1 1 0-92Z';

export function WaymarkMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      className={className}
      viewBox="138 96 236 328"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      focusable="false"
    >
      <path fill="currentColor" fillRule="evenodd" d={MARK_PATH} />
    </svg>
  );
}
