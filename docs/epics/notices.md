# Epic 12: Notices

## Status

📋 Planned.

## Overview

People hear about what concerns them: the bell always, email where they chose it, core's bell when hosted (14.1), and in phase 3 Web Push. Notices are
raised in the change's transaction, never for the person who acted. The bell and delivery follow Tally's (its §12); kinds are Waymark's and arrive with the
tasks that raise them.

## Related

[`DESIGN.md`](../../DESIGN.md) §17, §14.4

## Tasks

#### ✅ 12.1 — Notices and the bell

**Goal:** a person's notices in the app. **Design:** §17.1. **Depends on:** 7.1.

**Technical:** `notice` (details sealed), raised in the change's transaction through one function that never notifies the actor; the bell's unread count
to "99+", `NotificationsPanel`, `/notifications` by day, read per notice and "Mark all read"; a notice about a trip the person left hidden; kept 90 days,
at most 500 a person (a job); phase 1's `import_finished`; the kinds of phases 2 and 3 added by their tasks.

**Accepts when:** a finished import raises one notice for the importer; marking read survives a reload; a notice older than 90 days is gone.

**Done as, except the kinds that arrive with the tasks that raise them (`import_finished` with 8.1, the rest in phases 2 and 3), the hiding of a notice about a trip the person left (10.4), and `NotificationsPanel`'s own limits (below):** `notice` in both dialects (migration `0008_notices`): `id`, `account_id`, `kind`, `trip_id` (null until phase 2), `read_at` (null while unread), `sealed` (`SEALED.notice`: `{ title, detail?, href? }`) and `created_at`, indexed by person and time. **`src/notices/notices.ts`**, the one file that writes or reads `notice.sealed`: **`raiseNotice(tx, …)` is given the transaction of the change that causes the notice and never makes one for the person who acted** (the actor is passed in; the same person is no row), so a notice exists if and only if its change does (a test raises one in a transaction that is rolled back); `cleanContent` makes the title one line of at most 200 characters, the detail at most 500, and **leaves out an `href` that is not a path of this app** (`isAppPath`: a whole address, another host's, `//host` and `javascript:` are not somewhere a notice may send a person); `listNotices` (newest first, ties by id, a kind this version does not know is not shown), `unreadCount` (**counted by the database**, so the bell is right whatever the list holds), `markRead` and `markAllRead` (every statement names the person, so another person's notice is not found and marked 0; marking again keeps the time it was read), `pruneNotices` (**older than 90 days, and all but the newest 500 of a person**, by a window function over `ROW_NUMBER()`, standard on both dialects; safe to run twice) and `deleteNoticesOf`, **which `People.deletePerson` calls**: the deletion test lists the table as the person's, seeds one for each of two people and finds Ada's gone and Grace's whole. The `prune-notices` job runs every six hours under a lease (`claimJob`). **`/api/notices`** (`GET`: `{ unread, notices }`, `no-store`; `POST`: `{ ids }` of at most 100 ids that are ids, or `{ all: true }`, and nothing else; a body over 8 KB is cut off), for an account only, listed in `routes.ts`, `Origin` checked on the write, with a test that calls both as a second person. **The screens:** `NoticesProvider` (one copy shared by the bell and the page: read when the app opens, every minute while the window is in view, when it comes to the front and when the network returns; **marking is shown at once, sent after, and put right by reading again if the server did not take it**; offline it keeps what it last had and says nothing of the network), `NoticeBell` (the design system's `NotificationsPanel`: the unread count, which the panel itself caps at "99+", the newest twenty, each opening where it points and marking itself read, _Mark all read_, a link to the page) and `/notifications` (`NotificationsPage`: by day in the reader's own zone, "Today" and "Yesterday" then the date, an unread dot, _Mark all read_, and an empty state that says whether it is empty or could not be read). **The avatar menu now has Notifications.** `ago` is Tusk's, copied, as is the idea of one shared copy. **`NotificationsPanel` has a dismiss button on every row and a notice cannot be dismissed (it goes by itself after 90 days), so the button marks the notice read**; there is no _Clear all_. **Seen:** the module on a `file:` database, sqld and PostgreSQL (the same 230 tests in the data-layer files on each): raised for the person told and not the actor, sealed (the title is in no column and not readable in the envelope), listed, counted, marked once and for the person alone, pruned at 90 days and at 500 (503 raised, the oldest three go) and again changing nothing, and removed with the person; the two routes called with no session (401), from another origin or none (403), as the person and as a second person (who can mark nothing of theirs), and with every body that is not a change (400, naming nothing of it, and 413); the days of the page with the same moment on two different days in two zones; **in Chromium (`e2e/notices.spec.ts`), with the server's answers given by the test, since nothing raises a notice until 8.1:** the bell counts two unread and opening one goes where it points and marks it read, a hundred unread show "99+" and _Mark all read_ clears it and survives a reload, the page by day with detail and a notice from yesterday and one from forty days ago, the empty state, and with the network off the bell keeps what it had. **Left out:** the notices themselves (8.1 raises `import_finished`); a notice about a trip the person left is hidden by 10.4, which has trips to be a member of; email and the other channels (12.2, 12.3, 14.1, 12.4); and a dismiss that deletes, which nothing needs.

#### ✅ 12.2 — The mail outbox

**Goal:** mail sent in the background. **Design:** §17.2. **Depends on:** 1.6.

**Technical:** copy Tusk's mailer (`WAYMARK_SMTP_*`) and Tally's `mail_outbox` (address and data sealed), written in the change's transaction, claimed by a
job, retried with backoff, never logged with an address or content; templates in plain text and simple HTML from Waymark's own words, nothing loaded from
elsewhere; better-auth's verification and reset moved onto it.

**Accepts when:** against a fake SMTP server, a mail is sent once with two workers running, retried after a failure, and nothing of it is in the logs.

**Done as, except notices by email, which 12.3 adds (this task is the outbox and what already sends mail):** `mail_outbox` in both dialects (migration `0009_mail_outbox`): `id`, `account_id` (null for mail to someone with no account yet, a verification link), `kind` (`verification`, `reset`, `notice`), `attempts`, `next_attempt_at`, `claimed_until` (the lease), `sealed` (`SEALED.mail_outbox`: the address and `{ subject, text, html? }`) and `created_at`, indexed by when it is due and by person. **`src/mail/outbox.ts`**, from Tally's design and copied from no code (Tally has none yet): **`enqueueMail(tx, …)` is given the transaction of the change that causes the mail**, so a change that is rolled back sends nothing (tested); **`claimMail` takes the due rows in one statement** that names the conditions in the subquery that picks and in the update that takes (on PostgreSQL the loser of two workers that pick the same row waits for the winner and then finds it held), counts the try and holds the row for two minutes; **`sendDue`** sends what it claimed with the mailer it is given and deletes what went; what did not go is kept and its pause set (**1 minute, 5, 30, 2 hours, 6 hours**) and is **given up on, and deleted, after six tries or a day**, whichever is first (a reset link a day old is of no use, and one sent late is worse than none); a row that cannot be opened is given up on, since no try would open it; `dropStale` removes what no worker claimed; `deleteMailOf` is called by `People.deletePerson` (the deletion test lists the table, seeds one for each of two people and finds Ada's gone). **Delivery is at least once:** a worker that dies between sending and deleting has its message sent again when the lease ends, which the messages (a link, a notice) tolerate. **Nothing is logged but counts:** the job says how many it sent, will try again and gave up on, and `sendDue` writes nothing at all (a test captures every console level through a pass with a mail server that repeats the address and the subject in its complaint, and finds nothing); the mail server's complaint is dropped. The `send-mail` job runs every 30 seconds and does nothing with no `WAYMARK_SMTP_HOST`. **What already sent mail now goes through it:** `outboxMailer` is a `Mailer` that queues, and is what better-auth is given (`auth/server.ts`), so its verification and reset mail are written to the outbox and sent by the job; the request no longer waits for the mail server at all (it did not wait for the result before either, §6). **Messages have an HTML part** (`templates.ts`: `simpleHtml` and `escapeHtml`): a paragraph for each blank-line-separated block, a link where there is an address, **everything escaped** and **nothing loaded from anywhere** (no image, no style sheet, no tracking), plus the text part, sent as `multipart/alternative`. **A guard found a thing to say:** the sealed-field test reads the source for a condition on a sealed column and took `RETURNING … sealed` for one, so the returned columns are a fragment of their own, as in `places.ts`. **Seen** on a `file:` database, sqld and PostgreSQL (267 tests in the data-layer files on each): sealed (the address and subject are in no column and not readable in the envelope), queued in a transaction and rolled back with it, the sign-in library's mailer queuing both kinds, one pass sending and deleting, **forty messages and two workers running at the same time sending each exactly once**, a message another worker holds not being taken and being taken after its lease, a failed message waiting its pause (not a millisecond less) and then going, the pauses growing and the sixth failure deleting it, a day-old message given up on, an unopenable one given up on, nothing in the logs, a person's mail removed with them and no one else's, and **a message through a real SMTP server (the sink) once with two workers, text and HTML, the link in both and an address with markup in it escaped in the HTML**. Each safeguard was taken out in turn and seen to fail its test (the lease, the limit on tries). **Left out:** notices by email and the preferences that govern them (12.3); core's email for linked accounts (14.1); and a mail that bounces after the server took it, which nothing here can know.

#### 📋 12.3 — Preferences and email

**Goal:** each kind by channel. **Design:** §17.2, §21. **Depends on:** 12.1, 12.2.

**Technical:** `notice_pref` (kind, channel, on); defaults per kind; Settings > Notifications listing each kind with email (and core's bell once 14.1,
Web Push once 12.4), with what is unavailable said; email sent for a notice where on and mail is set up.

**Accepts when:** turning email off for a kind stops its mail and not its bell notice; with no SMTP, Settings says the bell is the only channel.

#### 📋 12.4 — Web Push

**Goal:** notices on the device, in phase 3. **Design:** §17.3, §19.3. **Depends on:** 12.3, 1.11.

**Technical:** **First:** whether the manifest's `generate` can make a VAPID key, or Waymark derives one from a random secret (§27), raised in `sovereign` if a
gap; `WAYMARK_VAPID_PRIVATE_KEY`; `push_subscription` (endpoint and keys sealed), one per device, subscribed from Settings and Trip Mode; a push job with the
same claims as mail, sent through 1.7's helper to the subscription's push service only; a payload naming the kind and a link, never a place name, note or
person's name; expired subscriptions removed; Settings explains iPhone's home-screen rule.

**Accepts when:** a notice reaches a subscribed Chromium once with two workers, a gone subscription is removed, and a payload carries no place or name.
