/**
 * Sets `data-theme` on the root element from the person's choice (Settings, Preferences: `light` or `dark`, kept in this browser), or from the
 * visitor's colour scheme when they have made none, before the page is painted, and keeps it in step when the system changes. The design
 * system's tokens switch on `[data-theme='dark']` and have no `prefers-color-scheme` rule of their own, so without this a dark-mode visitor gets
 * a light page.
 *
 * It is a script, not an effect, because an effect runs after the first paint and the page would flash light. It is inline, so a strict
 * Content-Security-Policy (task 1.7) must give it the same nonce Next gives its own inline scripts. The key is `src/theme/preferences.ts`'s,
 * which a test holds to this.
 */
export const themeScript = `(function () {
  var root = document.documentElement;
  var stored = function (key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  };
  try {
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    var apply = function () {
      var chosen = stored('waymark.theme');
      root.setAttribute('data-theme', chosen === 'light' || chosen === 'dark' ? chosen : query.matches ? 'dark' : 'light');
    };
    apply();
    query.addEventListener('change', apply);
  } catch (error) {}
})();`;
