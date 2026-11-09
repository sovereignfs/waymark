/**
 * What the landing page says (DESIGN.md §20.3), as typed content so that it is read in one place and cannot be half-edited. It says what is so today and nothing that
 * is only planned: a page that promises what the app does not do is worse than a short one. Trips and sharing are said when they are built (phase 2).
 */
export interface Feature {
  title: string;
  body: string;
}

export const landing = {
  heading: 'Where you have been, kept to yourself',
  lead: 'Check in where you are, and look back on everywhere you have been, on a map. Private to you, run by you or by your Sovereign instance.',
  features: [
    {
      title: 'A check-in takes a moment',
      body: 'A place, a note, a few photos. Waymark works from what is on your device, so it works with no connection and sends it when you are back.',
    },
    {
      title: 'Everywhere, on a map',
      body: 'Every place you have checked in is on a map that Waymark serves itself: nothing is loaded from another site, and no one is told where you are.',
    },
    {
      title: 'Yours alone',
      body: 'Where you were and what you wrote are encrypted before they are stored, on a server you choose. No telemetry, no third-party service.',
    },
  ] satisfies Feature[],
  signIn: 'Sign in',
  signUp: 'Create an account',
  noSignIn: 'Signing in is not set up on this server.',
} as const;
