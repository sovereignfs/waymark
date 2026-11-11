# Epic 10: Sharing

## Status

📋 Planned.

## Overview

Trips with the people going and the people following: three roles by how one takes part (Organizer, Traveler, Follower), invitations by notice, email or
link, check-ins private unless shared with the trip, and leaving without losing anything. Invitations follow Tally's (its §6.3); there are no
placeholders here.

## Related

[`DESIGN.md`](../../DESIGN.md) §5.2, §6, §11, §23

## Tasks

#### ✅ 10.1 — Roles

**Goal:** what each role may do, in every statement. **Design:** §11.1, §5.2. **Depends on:** 9.1.

**Technical:** `trip_member.role` and `going`; the role sets per operation and mutation in `src/access/`, used by `/api/ops`, sync (6.6) and media (9.5);
change a role, a person's "going"; the last Organizer held; `role_changed` raised once 12.1 is in; the test calling every trip operation as each lower role.

**Accepts when:** a Traveler cannot invite or delete; a Follower cannot edit anything or see an attachment; a trip never has no Organizer.

**Done as:** **The role sets** are in `src/access/trip.ts`, one place for every statement: `ORGANIZERS`, `EDITORS` (Organizers and Travelers) and `MEMBERS`, and now **`ATTACHMENT_READERS` (= `EDITORS`: never Followers)**, which 9.5's statements and 6.6's pull must use; `OPERATIONS` in `src/trips/ops.ts` says which set each operation needs, and the test that calls every operation as a stranger and as each lower role is driven by it (it fails to compile for an operation with no request, and now covers 21). **`src/trips/members.ts`:** **`setRole`** (`member.role`: an Organizer makes another member, or themselves, an Organizer, a Traveler or a Follower; **who goes follows the role** (Organizers and Travelers go, a Follower does not) and asking for the role they have changes and says nothing, advancing no counter) and **`setGoing`** (`member.going`: an Organizer's own "Not going" switch; a Traveler goes and a Follower does not, so they have no switch, and it is only ever one's own). **The last Organizer is held in the statement that changes the role** (`role <> 'organizer' OR another active Organizer exists`), after a guarded `UPDATE trip` that shows the caller is an Organizer and takes the trip's row, so that two Organizers demoting themselves, or each other, at the same moment leave one (tested both ways; with the clause taken out the sequential test and the concurrent self-demotion test fail); the refusal says so in a sentence. **A person who is not in the trip or has left it, a Traveler, a Follower and a stranger are all told it is not there**, the same words. **`role_changed`** (a new kind: the bell and core's bell by default) tells the person whose role changed, in a sentence that names the trip and the role, never the Organizer who changed it, and nothing when they changed their own; what it says is sealed. A role change takes effect at once for every statement (a Follower made a Traveler edits the plan, and one made a Follower stops; tested). **Seen**, on a `file:` database, sqld and PostgreSQL (the whole suite, 1345 tests, on each): every role and who goes, the counter, the last Organizer, concurrency, who may and who is told it is not there, the notice, the switch and the reset by a change of role. **Left out:** nothing adds a person to a trip yet (invitations, 10.2) or lets one leave or be removed (10.4, which hold the same last-Organizer rule), so a trip still has the people a test puts in it; "Ask an Organizer to invite" is a screen (11.7); sync's role checks per mutation are 6.6 and media's are 9.5, both using the sets above; and a Traveler lowered to Follower between syncs, whose item edit goes to Couldn't sync, is 6.6's.

#### 📋 10.2 — Invitations

**Goal:** bringing people into a trip with a role. **Design:** §11.2, §6.2. **Depends on:** 10.1, 12.2, 17.2.

**Technical:** `invitation` (one trip, one role; email sealed); by a name of someone the Organizer shares a trip with (a notice), by email (a notice to
an account with it, mail through 12.2 to any other address; the lookup rate-limited per account and hour), or as a link; token of 32 random bytes, stored
as its hash, compared in constant time, 14 days, single-use, revocable, resent once an hour; `/invite/<token>` showing the trip's name, dates and inviter
only, every invalid link the same page; accept by signing in or signing up (`WAYMARK_AUTH_SIGNUP=invite` from 17.2, the default from then); `invited` and
`invite_accepted`; the manifest's scopes gain `offline_access` and `directory` (used by 14.2).

**Accepts when:** a link sent through any channel is accepted by whoever holds it, once; an expired, revoked or used link shows the same page as a
wrong one; with no mail set up, the dialog offers the link and says email is not set up.

#### ✅ 10.3 — Sharing check-ins with a trip

**Goal:** check-ins private by default, shared by choice. **Design:** §11.3, §15.3. **Depends on:** 10.1, 6.6, 9.7.

**Technical:** `checkin.share` (`trip`, `on`, `off`) and `trip_member.share_checkins` (`ask`, `on`, `off`); the once-per-trip question on the first linked
check-in; `shared_checkin`, the reader's sealed copy in the trip's stream, written when shared or changed and removed when unshared, unlinked or the author
leaves; photos of a shared check-in served to the trip's members through 3.2's check; only Travelers' check-ins link and share; Settings > Check-ins'
default; `checkin_shared` (off by default) once 12.1 is in.

**Accepts when:** an unshared linked check-in never reaches another member's device or the server's answers to them; sharing makes it appear for a

**Done as:** **The rule is pure** (`src/sharing/rules.ts`, no database, for the device to run when trips are on it, 6.6): `sharedWith` says which trip a check-in is shared with, if any. It needs the check-in linked to a trip, its author **still an Organizer or a Traveler** of it, and then the check-in's own word (`on` shares, `off` keeps private whatever the trip says) or, when it says `trip`, the author's **choice for the trip** (`trip_member.share_checkins`), which while it is still `ask` is answered by their **default in Settings** (`profile.share_default`); **nothing is shared until the person has said so**, so the default of everything is private. `needsAnswer` is the once-per-trip question (a check-in that follows the trip, in a trip with other members, with nothing answering it), for the screen. **The copy** is the new table `shared_checkin` (migration `0022_sharing`, both dialects, in the table list and in rotation's phases): the check-in id (its key, so a check-in has at most one), the trip, the author, the **trip's number at the change** (`seq`) and a **sealed** body (`SEALED.shared_checkin`): the place (name, point, address, category), moment, zone, offset, note, companions and the **ids** of its photos, and nothing else of the author. **`src/sharing/copies.ts` `syncCopy` is the one function that makes a copy what it should be**, in the transaction of every change that could alter it: the check-in being written (`src/sync/apply.ts`, after its photos) or deleted, **its place being edited** (so a reader never holds the old name or point), a **job re-linking it** (`src/autolink/queue.ts`), the author's **role changing** (`setRole`: a Traveler made a Follower has nothing shared any more, made a Traveler again it comes back) and their **choice for the trip changing**. It writes, replaces, **moves to another trip** (the old trip is told of the removal) or removes the copy, each taking the trip's next number; **the statement that takes the number names the author's membership as Organizer or Traveler**, so a copy is never written for someone who may not share. **`setShareChoice`** (`member.share`, an online operation for Organizers and Travelers; for a Follower, a former member, a stranger and a trip that is not there, the same "not found") records the answer and makes the author's check-ins in that trip right in the same transaction: `on` shares the ones that follow the trip, `off` takes them back, and one that says `on` or `off` for itself is not touched. **What members are given** is `listShared` (`checkin.shared`, every member, Followers too): the **copies, never the originals**, opened on the server for the reader, past a number (`after`), the author's own left out; **an unshared check-in has no row, so there is nothing of it in any answer to another member**. **Photos:** `/api/media/<id>` (`readFileFor`) serves a photo, **and its thumbnail**, to a member of a trip the check-in is shared with (one statement joins the photo to its copy and to the reader's membership), after their own files and the attachments they may see; a stranger, a former member and a member of another trip are not given it, and unsharing stops it at once. **Leaving and deleting:** deleting a trip removes its copies (`shared_checkin` is `delete` in `TRIP_TABLES`, the originals stay with their authors, unlinked); deleting an account removes theirs from every trip, **before** any trip they were alone in goes (`endMembershipsOf`, tested with one of each in `people.test.ts`); `dropCopiesOf` is what 10.4's leave and remove call. **`checkin_shared`** (a new notice kind, off in every channel by default): raised in the transaction, once when a check-in is first shared (not when it is edited), **only for the members who turned it on**, naming the trip and nothing of the check-in or its author. **Seen**, on a `file:` database, sqld and PostgreSQL: the whole suite (1480 tests; 24 of them new) and the pure rule (6); private by default and after "no"; given to every member with its place, note, companions and photos and nothing of the author; a stranger, a former member and a trip that is not there are told alike; unsharing, unlinking by hand, linking to another trip and deleting each remove it and take a number; an edit of the check-in and of its place reach the copy; `after` returns only what changed; another account cannot touch a copy; the trip's choice and Settings' default; who may choose; a role change; the job re-linking after the trip is re-dated; leaving; deleting the trip; the photos and thumbnails to Followers and not to strangers; the notice to those who chose it only. With each of these taken out one test fails: the author's role in the rule, a choice of `ask` meaning `on`, the membership in the photo's statement, the copy's removal on delete, on a role change, on a place edit and in the job. **Two guards are defence in depth and no test can reach them alone** (taking either out changes nothing seen, since the rule and the reader's first statement already refuse): the membership in the statement that takes the trip's number, and in the reader's list query. **Left out:** **the trip's stream on devices is 6.6**, which pulls `checkin.shared` rows past a trip's cursor into the device (the answers above are what it will read) and **must also record a tombstone when a copy is removed**: a removal here deletes the row and takes a number, and trip streams have no tombstones yet (the same is true of every other trip row deleted so far), so a device is told by the next snapshot and not yet by a deletion; **the per-trip choice syncing offline** (§15.2) waits on the device's store for trips, and is online until then; **the screens** (the question on the check-in, "Share with the trip / Keep private", the trip page's choice, Settings > Check-ins) are 7.x and 11.x, over the operations that exist; the notice is not raised for a check-in a re-linking job shares, only for one a person's sync does, and **a bell-only choice for `checkin_shared`** needs a preference for the bell itself (a member who turns on email or core's bell is told in the bell too); a copy of a trip's lock order: a transaction that changes check-ins takes the account's counter and then the trip's row, while a trip's deletion takes the trip first, so PostgreSQL could abort one of two that meet (the person's device sends it again), a rare case that 10.4 should resolve when it orders leaving and removing; and **export and import (15.3)** do not carry copies, which are other people's views of a check-in and are made again when the original is.
Follower at the next sync, and unsharing removes it.

#### 📋 10.4 — Leaving, removing and handing over

**Goal:** people leave without losing anything. **Design:** §11.4, §23. **Depends on:** 10.1, 10.3.

**Technical:** leave (anyone; the last Organizer must name another), remove (Organizers); both unlink and unshare the person's check-ins from the trip in
the same transaction and end their membership; `People.deletePerson` gains the trip rules: hand over to the longest-standing Traveler, then Follower
(`organizer_passed`), delete a trip with no one left, clear `created_by` on items, attachments and links.

**Accepts when:** after leaving, nothing of the person's check-ins is in the trip's stream; deleting the only Organizer's account hands the trip over and
tells the new Organizer; a trip with no one left is gone.
