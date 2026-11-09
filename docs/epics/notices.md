# Epic 12: Notices

## Status

📋 Planned.

## Overview

People hear about what concerns them: the bell always, email where they chose it, core's bell when hosted (14.1), and in phase 3 Web Push. Notices are
raised in the change's transaction, never for the person who acted. The bell and delivery follow Tally's (its §12); kinds are Roam's and arrive with the
tasks that raise them.

## Related

[`DESIGN.md`](../../DESIGN.md) §17, §14.4

## Tasks

#### 📋 12.1 — Notices and the bell

**Goal:** a person's notices in the app. **Design:** §17.1. **Depends on:** 7.1.

**Technical:** `notice` (details sealed), raised in the change's transaction through one function that never notifies the actor; the bell's unread count
to "99+", `NotificationsPanel`, `/notifications` by day, read per notice and "Mark all read"; a notice about a trip the person left hidden; kept 90 days,
at most 500 a person (a job); phase 1's `import_finished`; the kinds of phases 2 and 3 added by their tasks.

**Accepts when:** a finished import raises one notice for the importer; marking read survives a reload; a notice older than 90 days is gone.

#### 📋 12.2 — The mail outbox

**Goal:** mail sent in the background. **Design:** §17.2. **Depends on:** 1.6.

**Technical:** copy Tusk's mailer (`ROAM_SMTP_*`) and Tally's `mail_outbox` (address and data sealed), written in the change's transaction, claimed by a
job, retried with backoff, never logged with an address or content; templates in plain text and simple HTML from Roam's own words, nothing loaded from
elsewhere; better-auth's verification and reset moved onto it.

**Accepts when:** against a fake SMTP server, a mail is sent once with two workers running, retried after a failure, and nothing of it is in the logs.

#### 📋 12.3 — Preferences and email

**Goal:** each kind by channel. **Design:** §17.2, §21. **Depends on:** 12.1, 12.2.

**Technical:** `notice_pref` (kind, channel, on); defaults per kind; Settings > Notifications listing each kind with email (and core's bell once 14.1,
Web Push once 12.4), with what is unavailable said; email sent for a notice where on and mail is set up.

**Accepts when:** turning email off for a kind stops its mail and not its bell notice; with no SMTP, Settings says the bell is the only channel.

#### 📋 12.4 — Web Push

**Goal:** notices on the device, in phase 3. **Design:** §17.3, §19.3. **Depends on:** 12.3, 1.11.

**Technical:** **First:** whether the manifest's `generate` can make a VAPID key, or Roam derives one from a random secret (§27), raised in `sovereign` if a
gap; `ROAM_VAPID_PRIVATE_KEY`; `push_subscription` (endpoint and keys sealed), one per device, subscribed from Settings and Trip Mode; a push job with the
same claims as mail, sent through 1.7's helper to the subscription's push service only; a payload naming the kind and a link, never a place name, note or
person's name; expired subscriptions removed; Settings explains iPhone's home-screen rule.

**Accepts when:** a notice reaches a subscribed Chromium once with two workers, a gone subscription is removed, and a payload carries no place or name.
