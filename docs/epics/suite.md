# Epic 14: The suite

## Status

📋 Planned.

## Overview

What a Sovereign instance adds when it hosts Waymark: core's bell, email and activity page, and its directory to find people to invite. Each is an addition: a
call that fails, is refused or is not supported changes nothing but that call, and every feature works the same without it.

## Related

[`DESIGN.md`](../../DESIGN.md) §17.2, §19.3, §19.4, §27

## Tasks

#### 📋 14.1 — Core's bell, email, activity

**Goal:** core's services for people linked to core. **Design:** §17.2, §19.4. **Depends on:** 2.3, 12.3.

**Technical:** through `@sovereignfs/sdk` on the server: `sv.app.notifications.send` for notices where core's bell is on (a link back to the notice's
place), `sv.app.email.sendToUser` for linked accounts in place of Waymark's mail where granted, `sv.app.activity.log` for export, import and deletion; each
with a `key`; `NotSupportedError`, a refusal or no core changes nothing else; Settings shows core's bell as a channel only when hosted.

**Accepts when:** against `createFakeCore`, each call is made once with its key; with the scopes not granted or an older core, the bell and Waymark's mail
still work.

#### 📋 14.2 — Core's directory

**Goal:** finding people on the instance to invite. **Design:** §11.2, §19.3. **Depends on:** 2.3, 10.2.

**Technical:** `sv.as({ sub }).directory.searchUsers` with the person's refresh token, kept through `src/crypto/` in the SDK's `tokenStore` (how
better-auth's `genericOAuth` feeds it is checked here, or settled by Tally's 11.2 if built first; a gap raised in `sovereign`); results in the invite field
beside Waymark's own; an invitation to a directory person delivered by core's bell and taken by their first sign-in through core by `sub`; scopes refused
means inviting works as alone.

**Accepts when:** against the fake core, a directory person is invited and, signing in through core, lands in the trip with their role.
