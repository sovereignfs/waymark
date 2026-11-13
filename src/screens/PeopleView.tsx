'use client';

import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  CopyButton,
  Dialog,
  FormField,
  Icon,
  Input,
  Select,
  Toggle,
} from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import { ROLES, type Role } from '../trips/format';
import { goTo } from './checkin-location';
import { NOT_DONE, NO_CONNECTION, type OpAnswer, askOp } from './ops';
import {
  type Member,
  ROLE_HELP,
  type Waiting,
  actionsFor,
  canResend,
  expiresText,
  leaveWay,
  membersInOrder,
  organizersOf,
  suggestPeople,
  waitingFor,
} from './people';
import styles from './People.module.css';
import { ROLE_LABEL } from './trip';

type Dialog_ = 'invite' | 'leave' | undefined;

/**
 * The People (DESIGN.md §11, §20.10): the members by role with their names (an address only for an Organizer, §6.1), who is going, and, for an Organizer, the role of each, _Remove_, the invitations that are waiting (resend and
 * revoke) and **Invite**: a person by name (from those the Organizer shares a trip with), an address, or a link with a QR code, in a role. **Leave** is everyone's, and the last Organizer says who takes over. These are online
 * operations (§15.7): the server decides, and the answer is pulled into the device at once.
 */
export function PeopleView({ tripId, data }: { tripId: string; data: TripData }) {
  const local = useLocal();
  const sets = data.sets;
  const [dialog, setDialog] = useState<Dialog_>(undefined);
  const [removing, setRemoving] = useState<Member | undefined>(undefined);
  const [waiting, setWaiting] = useState<readonly Waiting[] | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [now] = useState(() => Date.now());

  const members = useMemo(() => membersInOrder((sets?.members ?? []) as Member[]), [sets?.members]);
  const organizer = data.role === 'organizer';
  const organizers = organizersOf(members);

  const loadWaiting = useCallback(async () => {
    if (!organizer) return;
    const answer = await askOp({ op: 'invite.list', tripId });
    if (answer?.ok && answer.invitations) setWaiting(answer.invitations);
  }, [organizer, tripId]);
  useEffect(() => {
    void loadWaiting();
  }, [loadWaiting]);

  if (!sets) return null;

  /** Runs an operation, then pulls its answer into the device; says what went wrong in a sentence. */
  const run = async (body: Record<string, unknown>): Promise<OpAnswer | undefined> => {
    setNotice(undefined);
    const answer = await askOp({ tripId, ...body });
    if (!answer) setNotice(NO_CONNECTION);
    else if (!answer.ok) setNotice(answer.sentence ?? NOT_DONE);
    else {
      await local?.syncNow();
      return answer;
    }
    return undefined;
  };

  return (
    <div className={styles.people}>
      <div className={styles.head}>
        <h2>People</h2>
        <div className={styles.headActions}>
          {organizer ? (
            <Button onClick={() => setDialog('invite')}>
              <Icon name="user-plus" aria-hidden /> Invite
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setDialog('leave')}>
            Leave the trip
          </Button>
        </div>
      </div>
      {!organizer ? (
        <p className={styles.muted}>Ask an Organizer to invite someone, or to change a role.</p>
      ) : null}
      {notice ? (
        <p role="alert" className={styles.problem}>
          {notice}
        </p>
      ) : null}

      <ul className={styles.members} aria-label="Members">
        {members.map((person) => {
          const actions = actionsFor({ role: data.role }, person, organizers);
          return (
            <li key={person.accountId} className={styles.member} data-member={person.accountId}>
              <Avatar name={person.name} size="md" />
              <span className={styles.who}>
                <span className={styles.name}>
                  {person.name}
                  {person.self ? <span className={styles.muted}> (you)</span> : null}
                </span>
                {person.email ? <span className={styles.muted}>{person.email}</span> : null}
              </span>
              {actions.changeRole === 'no' ? (
                <Badge variant="role" uppercase={false}>
                  {ROLE_LABEL[person.role]}
                </Badge>
              ) : (
                <Select
                  aria-label={`Role of ${person.name}`}
                  value={person.role}
                  disabled={actions.changeRole === 'last'}
                  title={actions.changeRole === 'last' ? 'Make another Organizer first' : undefined}
                  onChange={(event) =>
                    void run({
                      op: 'member.role',
                      accountId: person.accountId,
                      role: event.target.value,
                    })
                  }
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABEL[role]}
                    </option>
                  ))}
                </Select>
              )}
              {actions.goingSwitch ? (
                <span className={styles.going}>
                  <Toggle
                    aria-label="I am going"
                    checked={person.going}
                    onChange={(going) => void run({ op: 'member.going', going })}
                  />
                  <span>Going</span>
                </span>
              ) : person.role === 'follower' ? null : (
                <span className={styles.muted}>{person.going ? 'Going' : 'Not going'}</span>
              )}
              {actions.remove ? (
                <Button
                  variant="ghost"
                  aria-label={`Remove ${person.name}`}
                  onClick={() => setRemoving(person)}
                >
                  <Icon name="user-x" aria-hidden />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {organizer ? (
        <section aria-label="Waiting to join" className={styles.waiting}>
          <h3>Waiting to join</h3>
          {waiting === undefined ? (
            <p className={styles.muted}>Looking for invitations…</p>
          ) : waiting.length === 0 ? (
            <p className={styles.muted}>No one is waiting.</p>
          ) : (
            <ul className={styles.members}>
              {waiting.map((invitation) => (
                <li key={invitation.id} className={styles.member} data-invitation={invitation.id}>
                  <span className={styles.who}>
                    <span className={styles.name}>{waitingFor(invitation)}</span>
                    <span className={styles.muted}>
                      {ROLE_LABEL[invitation.role]} · {expiresText(invitation, now)}
                    </span>
                  </span>
                  {canResend(invitation, now) ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void run({ op: 'invite.resend', invitationId: invitation.id }).then(
                          loadWaiting,
                        )
                      }
                    >
                      Resend
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    aria-label={`Withdraw the invitation of ${waitingFor(invitation)}`}
                    onClick={() =>
                      void run({ op: 'invite.revoke', invitationId: invitation.id }).then(
                        loadWaiting,
                      )
                    }
                  >
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <InviteDialog
        open={dialog === 'invite'}
        tripId={tripId}
        members={members}
        onClose={() => {
          setDialog(undefined);
          void loadWaiting();
        }}
      />
      <LeaveDialog
        open={dialog === 'leave'}
        tripId={tripId}
        members={members}
        onClose={() => setDialog(undefined)}
      />
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        title="Remove this person?"
        size="sm"
      >
        <div className={styles.form}>
          <p>
            <strong>{removing?.name}</strong> will be taken out of the trip. Their check-ins stop
            following it and stop being shared with it; what they wrote in the plan stays.
          </p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setRemoving(undefined)}>
              Keep them
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(undefined);
                if (target) void run({ op: 'member.remove', accountId: target.accountId });
              }}
            >
              Remove them
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

type Way = 'person' | 'email' | 'link';

/** Whom the Organizer chose: someone they share a trip with (by their account here), or someone core's directory named (by their `sub`, which the server looks up again). */
type Chosen =
  | { readonly kind: 'known'; readonly accountId: string; readonly name: string }
  | { readonly kind: 'directory'; readonly sub: string; readonly name: string };

/** What core's directory said to the last search: nothing asked yet, the people it named, no directory here, or no answer now. */
interface DirectoryState {
  readonly status: 'unknown' | 'on' | 'off' | 'failed';
  readonly people: readonly { readonly sub: string; readonly name: string }[];
}
const NO_DIRECTORY: DirectoryState = { status: 'unknown', people: [] };
/** A pause in typing before the directory is asked: a search for each key would be a request for each key. */
const TYPING_PAUSE_MS = 250;

/** _Invite_ (DESIGN.md §11.2): a role, and a person by name, an address or a link. With no mail the dialog says the link is the only way. **The link is shown once**: only its hash is kept. */
function InviteDialog({
  open,
  tripId,
  members,
  onClose,
}: {
  open: boolean;
  tripId: string;
  members: readonly Member[];
  onClose: () => void;
}) {
  const local = useLocal();
  const [role, setRole] = useState<Role>('traveler');
  const [way, setWay] = useState<Way>('link');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Chosen | undefined>(undefined);
  const [directory, setDirectory] = useState<DirectoryState>(NO_DIRECTORY);
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<NonNullable<OpAnswer['invitation']> | undefined>(undefined);
  const [seen, setSeen] = useState(false);
  if (open !== seen) {
    setSeen(open);
    if (open) {
      setRole('traveler');
      setWay('link');
      setQuery('');
      setChosen(undefined);
      setDirectory(NO_DIRECTORY);
      setEmail('');
      setProblem(undefined);
      setBusy(false);
      setSent(undefined);
    }
  }
  const suggestions = useMemo(
    () =>
      suggestPeople(local?.trips ?? [], query, new Set(members.map((member) => member.accountId))),
    [local?.trips, query, members],
  );

  // Core's directory, asked a moment after the typing stops, and only where there is one (`off` says there is not, and then it is not asked again for this dialog).
  const searching = open && way === 'person' && !chosen && directory.status !== 'off';
  useEffect(() => {
    const q = query.trim();
    if (!searching || q === '') return;
    let current = true;
    const timer = setTimeout(() => {
      void askOp({ op: 'people.directory', tripId, q }).then((answer) => {
        if (!current || !answer) return;
        if (answer.ok && answer.directory)
          setDirectory({ status: answer.directory, people: answer.people ?? [] });
        else setDirectory({ status: 'failed', people: [] });
      });
    }, TYPING_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [searching, query, tripId]);
  // The names already offered as people the Organizer shares a trip with are not offered twice.
  const fromDirectory =
    query.trim() === '' || directory.status !== 'on'
      ? []
      : directory.people.filter(
          (person) =>
            !suggestions.some((known) => known.name.toLowerCase() === person.name.toLowerCase()),
        );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (way === 'person' && !chosen) return setProblem('Choose a person from the list.');
    if (way === 'email' && email.trim() === '') return setProblem('Type an email address.');
    setBusy(true);
    setProblem(undefined);
    const answer = await askOp({
      op: 'invite.create',
      tripId,
      role,
      ...(way === 'person' && chosen
        ? chosen.kind === 'known'
          ? { accountId: chosen.accountId }
          : { sub: chosen.sub }
        : {}),
      ...(way === 'email' ? { email: email.trim() } : {}),
    });
    if (!answer) setProblem(NO_CONNECTION);
    else if (!answer.ok || !answer.invitation) setProblem(answer.sentence ?? NOT_DONE);
    else setSent(answer.invitation);
    setBusy(false);
  };

  if (sent)
    return (
      <Dialog open={open} onClose={onClose} title="Invitation made" size="sm">
        <div className={styles.form}>
          <p>
            {sent.via === 'link'
              ? 'Send this link to whoever should join. Anyone who has it can join, once.'
              : sent.via === 'account'
                ? 'They have been told in Waymark. The link is here too, if you want to send it another way.'
                : sent.via === 'directory'
                  ? 'They have been told by the instance. They join when they open the invitation or, if they have not used Waymark yet, when they first sign in with Sovereign. The link is here too, if you want to send it another way.'
                  : sent.mail
                    ? 'An email is on its way. The link is here too, if you want to send it another way.'
                    : 'This server cannot send email, so the link is the only way: send it yourself.'}
          </p>
          {!sent.mail && sent.via !== 'account' && sent.via !== 'directory' ? (
            <p className={styles.muted}>This server has no email set up.</p>
          ) : null}
          <Input
            aria-label="The invitation link"
            readOnly
            value={sent.link}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className={styles.qr}>
            <QRCodeSVG value={sent.link} size={160} title="The invitation link as a QR code" />
          </div>
          <p className={styles.muted}>
            It is shown once. It works for 14 days, and can be withdrawn from the list.
          </p>
          <div className={styles.actions}>
            <CopyButton
              text={sent.link}
              label="Copy the link"
              copiedLabel="Copied"
              failedLabel="Could not copy"
            />
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </Dialog>
    );

  return (
    <Dialog open={open} onClose={onClose} title="Invite someone" size="sm">
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <FormField label="Role" hint={ROLE_HELP[role]}>
          {(field) => (
            <Select
              {...field}
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ROLES.map((each) => (
                <option key={each} value={each}>
                  {ROLE_LABEL[each]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="How">
          {(field) => (
            <Select
              {...field}
              name="way"
              value={way}
              onChange={(event) => setWay(event.target.value as Way)}
            >
              <option value="link">With a link to send</option>
              <option value="email">By email</option>
              <option value="person">A person by name</option>
            </Select>
          )}
        </FormField>
        {way === 'email' ? (
          <FormField label="Email address">
            {(field) => (
              <Input
                {...field}
                type="email"
                name="email"
                value={email}
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>
        ) : null}
        {way === 'person' ? (
          chosen ? (
            <div className={styles.chosen}>
              <span>
                <strong>{chosen.name}</strong>
              </span>
              <Button type="button" variant="ghost" onClick={() => setChosen(undefined)}>
                Change
              </Button>
            </div>
          ) : (
            <>
              <FormField
                label="Name"
                hint={`People you already share a trip with${directory.status === 'on' ? ', and the people of this instance' : ''}.`}
              >
                {(field) => (
                  <Input
                    {...field}
                    name="name"
                    value={query}
                    autoComplete="off"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                )}
              </FormField>
              {suggestions.length > 0 ? (
                <ul className={styles.found} aria-label="People found">
                  {suggestions.map((each) => (
                    <li key={each.accountId}>
                      <button
                        type="button"
                        onClick={() =>
                          setChosen({ kind: 'known', accountId: each.accountId, name: each.name })
                        }
                      >
                        {each.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {fromDirectory.length > 0 ? (
                <>
                  <p className={styles.muted}>On this instance</p>
                  <ul className={styles.found} aria-label="People on this instance">
                    {fromDirectory.map((each) => (
                      <li key={each.sub}>
                        <button
                          type="button"
                          onClick={() =>
                            setChosen({ kind: 'directory', sub: each.sub, name: each.name })
                          }
                        >
                          {each.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {query.trim() !== '' && suggestions.length === 0 && fromDirectory.length === 0 ? (
                <p className={styles.muted}>
                  {directory.status === 'on'
                    ? 'No one you share a trip with, and no one on this instance, has that name. Use an email address or a link.'
                    : 'No one you share a trip with has that name. Use an email address or a link.'}
                </p>
              ) : null}
              {directory.status === 'failed' && query.trim() !== '' ? (
                <p className={styles.muted}>The instance’s directory did not answer just now.</p>
              ) : null}
            </>
          )
        ) : null}
        {problem ? (
          <p role="alert" className={styles.problem}>
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Making it…' : 'Make the invitation'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** _Leave the trip_ (DESIGN.md §11.4): for everyone. The last Organizer names who takes over first; the only one in a trip is told to delete it instead. */
function LeaveDialog({
  open,
  tripId,
  members,
  onClose,
}: {
  open: boolean;
  tripId: string;
  members: readonly Member[];
  onClose: () => void;
}) {
  const local = useLocal();
  const way = leaveWay(members);
  const [successor, setSuccessor] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const leave = async () => {
    setBusy(true);
    setProblem(undefined);
    const answer = await askOp({
      op: 'member.leave',
      tripId,
      ...(way.kind === 'hand-over' ? { successor } : {}),
    });
    if (!answer) setProblem(NO_CONNECTION);
    else if (!answer.ok) setProblem(answer.sentence ?? NOT_DONE);
    else {
      await local?.syncNow();
      onClose();
      goTo('/trips', 'replace');
      return;
    }
    setBusy(false);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Leave the trip?" size="sm">
      <div className={styles.form}>
        {way.kind === 'delete-instead' ? (
          <p>
            You are the only one in this trip, so there is no one to leave it to. Delete it from the
            menu at the top instead.
          </p>
        ) : (
          <>
            <p>
              Your check-ins stop following this trip and stop being shared with it. What you wrote
              in the plan stays with the trip.
            </p>
            {way.kind === 'hand-over' ? (
              <FormField label="You are the last Organizer. Who takes over?">
                {(field) => (
                  <Select
                    {...field}
                    name="successor"
                    value={successor}
                    onChange={(event) => setSuccessor(event.target.value)}
                  >
                    <option value="">Choose a person</option>
                    {way.successors.map((each) => (
                      <option key={each.accountId} value={each.accountId}>
                        {each.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            ) : null}
          </>
        )}
        {problem ? (
          <p role="alert" className={styles.problem}>
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose}>
            Stay
          </Button>
          {way.kind === 'delete-instead' ? null : (
            <Button
              variant="destructive"
              disabled={busy || (way.kind === 'hand-over' && successor === '')}
              onClick={() => void leave()}
            >
              Leave the trip
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
