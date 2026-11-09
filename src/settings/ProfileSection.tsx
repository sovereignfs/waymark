'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert, Avatar, Button, FormField, Input, Select } from '@sovereignfs/ui';
import styles from './Settings.module.css';

/** The longest a display name may be: a line, as a person writes their own. */
export const MAX_NAME_LENGTH = 100;

export interface ProfileView {
  name: string;
  email: string;
  units: 'km' | 'mi';
  weekStart: number;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Settings, Profile (DESIGN.md §6.1, §21): who the person is here. Their initials, the name they are shown under (which a trip's other members will see), their units (kilometres
 * or miles) and the first day of the week, which they can change, and their address, which is shown and is not changed here: it is the one they sign in with. Saving needs a
 * connection, and says so when there is none.
 */
export function ProfileSection({ profile }: { profile: ProfileView }) {
  const router = useRouter();
  const [name, setName] = useState(profile.name);
  const [units, setUnits] = useState(profile.units);
  const [weekStart, setWeekStart] = useState(profile.weekStart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const trimmed = name.trim();
  const changed =
    trimmed !== profile.name || units !== profile.units || weekStart !== profile.weekStart;
  const valid = trimmed !== '' && trimmed.length <= MAX_NAME_LENGTH;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const reply = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed, units, weekStart }),
      });
      if (!reply.ok) {
        setError(
          reply.status === 400
            ? 'That could not be saved: check the name and try again.'
            : 'That could not be saved. Try again in a moment.',
        );
        return;
      }
      const saved = (await reply.json()) as ProfileView;
      setName(saved.name);
      setUnits(saved.units);
      setWeekStart(saved.weekStart);
      setSaved(true);
      // The menu, and every page that says who is signed in, read it from the profile.
      router.refresh();
    } catch {
      setError('This needs a connection. Try again when you are back online.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.group}>
        <h2>Avatar</h2>
        <div className={styles.row}>
          <Avatar name={profile.name} size="lg" />
          <p className={styles.hint}>Your initials.</p>
        </div>
      </div>
      <form onSubmit={onSubmit} className={styles.form} aria-label="Profile">
        <div className={styles.group}>
          <h2>Display name</h2>
          {error ? <Alert variant="error">{error}</Alert> : null}
          {saved ? <Alert variant="success">Your profile is saved.</Alert> : null}
          <FormField
            label="Name"
            required
            error={
              trimmed.length > MAX_NAME_LENGTH
                ? `At most ${MAX_NAME_LENGTH} characters.`
                : undefined
            }
          >
            {(field) => (
              <Input
                {...field}
                name="name"
                autoComplete="name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
                disabled={busy}
              />
            )}
          </FormField>
        </div>
        <div className={styles.group}>
          <h2>Distances and weeks</h2>
          <FormField label="Distances in">
            {(field) => (
              <Select
                {...field}
                name="units"
                value={units}
                disabled={busy}
                onChange={(event) => {
                  setUnits(event.target.value === 'mi' ? 'mi' : 'km');
                  setSaved(false);
                }}
              >
                <option value="km">Kilometres</option>
                <option value="mi">Miles</option>
              </Select>
            )}
          </FormField>
          <FormField label="The week starts on">
            {(field) => (
              <Select
                {...field}
                name="weekStart"
                value={weekStart}
                disabled={busy}
                onChange={(event) => {
                  setWeekStart(Number(event.target.value));
                  setSaved(false);
                }}
              >
                {DAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
        <div>
          <Button type="submit" loading={busy} disabled={!changed || !valid}>
            Save
          </Button>
        </div>
      </form>
      <div className={styles.group}>
        <h2>Email address</h2>
        <p>{profile.email}</p>
        <p className={styles.hint}>The address you sign in with.</p>
      </div>
    </>
  );
}
