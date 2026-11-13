# Security reviews

The security review of **0.1.0**, which is the first release and contains all three of the app's phases, is in three parts, named for the phases the design (`DESIGN.md` §2) orders the work in. Each part says what it checked, where
each rule is held (the code, and the test that fails when it stops being true), and what was found and whether it was fixed or recorded.

| Part                            | What it covers                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Check-ins (phase 1)](0.1.0.md) | access, sealing, files and uploads, the server's outbound requests, the CSP, sign-in and core's notices, deletion, the service worker                          |
| [Trips (phase 2)](0.2.0.md)     | roles in every statement, the device and the stream, sharing, invitations, attachments, auto-link, export and deletion, core's directory and its refresh token |
| [Trip Mode (phase 3)](0.3.0.md) | Web Push, reminders and Today, a trip's map kept on the device, Directions                                                                                     |

A finding is **fixed** (and says in which change), or **recorded** with what it costs and why it stands. What a part could not check (Web Push from a real push service, Directions on an iPhone, the directory against a
real Sovereign core, a live instance, the Swarm import) is said in its own words at the top of the part, and is what the first run on a live instance is for.
