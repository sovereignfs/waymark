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

#### 📋 10.3 — Sharing check-ins with a trip

**Goal:** check-ins private by default, shared by choice. **Design:** §11.3, §15.3. **Depends on:** 10.1, 6.6, 9.7.

**Technical:** `checkin.share` (`trip`, `on`, `off`) and `trip_member.share_checkins` (`ask`, `on`, `off`); the once-per-trip question on the first linked
check-in; `shared_checkin`, the reader's sealed copy in the trip's stream, written when shared or changed and removed when unshared, unlinked or the author
leaves; photos of a shared check-in served to the trip's members through 3.2's check; only Travelers' check-ins link and share; Settings > Check-ins'
default; `checkin_shared` (off by default) once 12.1 is in.

**Accepts when:** an unshared linked check-in never reaches another member's device or the server's answers to them; sharing makes it appear for a
Follower at the next sync, and unsharing removes it.

#### 📋 10.4 — Leaving, removing and handing over

**Goal:** people leave without losing anything. **Design:** §11.4, §23. **Depends on:** 10.1, 10.3.

**Technical:** leave (anyone; the last Organizer must name another), remove (Organizers); both unlink and unshare the person's check-ins from the trip in
the same transaction and end their membership; `People.deletePerson` gains the trip rules: hand over to the longest-standing Traveler, then Follower
(`organizer_passed`), delete a trip with no one left, clear `created_by` on items, attachments and links.

**Accepts when:** after leaving, nothing of the person's check-ins is in the trip's stream; deleting the only Organizer's account hands the trip over and
tells the new Organizer; a trip with no one left is gone.
