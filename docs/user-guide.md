# Using Waymark

A short guide for the people who use it. Whoever runs your Waymark sets up the address and the sign-in; this is what you do with it.

## Signing in

Open the address you were given. If your Waymark is part of a Sovereign instance, choose **Sign in with Sovereign**; otherwise sign in with your email and password, or a passkey. The first person to open a new Waymark makes the
first account on the sign-up page, and after that people join by invitation, unless whoever runs it opened sign-up. Settings is where you set up a passkey or an authenticator app, change your name, and choose which notices reach
you and how.

## Checking in

**Check in** is the button at the top of the sidebar (on a phone, the round button at the bottom; on a keyboard, the key `c`). Choose where you are:

1. **Here** uses your position, **Search** finds a place by name, and **On the map** lets you choose a point. Or choose a place you have been to before. If the place is not found, add it by hand, with a name and a point.
2. Add a note, who was with you, and photos if you like. Nothing is required but the place.
3. Save. The check-in has the moment you made it, in the time zone you were in, even if you save it later.

A check-in is yours alone. It is written on your device first, so **you can check in with no connection**: it is kept on the device and sent when the connection comes back. If the server ever refuses a change, it is kept
and not thrown away (Settings, _Couldn't sync_).

You can change or delete a check-in from its page, where its photos open in a viewer. **Check-ins** lists them newest first, with a search that looks at places and notes, and filters by year, category and country. **Places**
lists every place you have been to, the most visited first, with how many times; open one to see its check-ins, rename it, or **merge** two that are the same place. **Home** is today and the places you go back to, and **Map**
shows everywhere you have been, with the same filters: choose a place to see its visits.

## Trips

A trip is a folder your check-ins fall into when the dates match. **Trips** lists them; make one, give it a name, and add its **stops** (a place, and when you arrive and leave). A trip's page has these views:

- **Overview**: when, where, who is going, what is next, and whether it is planned or ready.
- **Plan**: the stops across the top and the days below, with the things you will do each day, in order, timed or not. Mark a trip _ready_ when the plan is settled.
- **Map**: the stops and each day's route, with the list of the same places beside it.
- **Journal**: what was planned against what happened, from the check-ins that fall into the trip.
- **Files**: bookings, tickets and links for the trip (not shown to Followers).
- **People**: who is in the trip, and, for an Organizer, the roles and the invitations.

There are three roles. **Organizers** run the trip and its people, **Travelers** are going and edit the plan, and **Followers** can look at the plan and what you share, but see no files. To bring someone in, an Organizer chooses
**Invite**: a link to send (shown once, good for 14 days), an email address, or a person by name; on a Sovereign instance, that includes the people of the instance. An invitation is for one trip with one role, and can be
withdrawn from the list.

**Sharing check-ins with a trip is your choice.** When one of your check-ins falls into a trip that has other people, Waymark asks you once whether to share your check-ins on that trip. Say yes and the members get a copy of the
check-in (the place, the moment, the note and the photos); say no and nothing is shared. You can change it for a check-in, or for the trip, at any time, and leaving a trip takes your copies out of it.

## On the trip: Trip Mode

On the days of a trip, **Today** shows the day as a list, in order, with the next thing and how long until it, a **Directions** button that opens your phone's own maps, and **Check in** for that place. Mark things done as
you go. Settings has the reminders (the evening before, and before a timed item) for each trip, and **Web Push** if you want them on your phone when Waymark is closed; a notification says only that there is something to see.

## Working offline

Waymark installs as an app on your phone or computer (use your browser's _Install_ or _Add to Home Screen_). What you do while you have no connection (checking in, editing, deleting) is kept on your device and sent when you
are back online. Opening Waymark with no connection works for Home, Check-ins, a check-in, Map, Places, a place, Trips and a trip's Today, once you have used Waymark on that device. Settings, notices, importing and exporting need
a connection, and so do searching for a new place and the things that are decided by the server at once: making a trip, its stops, roles and invitations.

**To have a trip's map with no connection,** open the trip's Overview and choose **Download for offline**: the map around its stops is kept on the device. Settings, _Maps kept for offline_ lists them and lets go of them, and
signing out removes them.

## Bringing your places in

**Settings, Data** has **Import a Waymark file**: choose a ZIP made by **Export** (in the same place), and its places, check-ins, photos and trips are added to your account as new ones, by a background job you can leave
while it works. A check-in that is already here is not added twice, and one you deleted stays deleted. Importing from Swarm (Foursquare) is not in this release.

**Export** makes one ZIP of everything that is yours, also in the background; you are told when it is ready. Deleting your account (Settings, Data) removes everything of yours, files included, from the server.

## What stays private

Your places, notes, names and photos are encrypted on the server. A check-in reaches another person only if you share it with a trip they are on, and then as a copy, with its place, note and photos, for everyone in the trip, Followers too. A trip's files (bookings, tickets) never
reach a Follower. Nothing is shared until you answer. There are no points, badges or streaks, and nobody is ranked.
