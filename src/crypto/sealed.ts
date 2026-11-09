import { type Binding, openBytes, sealBytes } from './envelope';
import type { KeyRing } from './keys';

/**
 * **The one place a row's `sealed` column is made or read** (DESIGN.md §18.1). Everything that says where or what is sealed: a table has one `sealed` column holding
 * its sensitive fields as one envelope, with one data key per row, bound to the row's id and the table's name. The rest of a row (ids, owners, moments, zones, kinds,
 * order, sharing, roles, sizes) is plain, because the database must sort, join and count by it.
 *
 * **A sealed field is never a column, and never in a `WHERE`, an `ORDER BY` or an index.** Search, distance, the map and the figures work in memory on rows that have
 * been unsealed, on the device or on the server for the person's or trip's own rows. `sealed.test.ts` holds the schemas to that, and the source.
 *
 * What a table seals is declared once, below, with the words of `DESIGN.md` §24.3 beside it (a test reads the design and fails if the two disagree). A table is
 * added here before its first row is written, which is why this task comes before every table of the product (3.1).
 */
export type FieldKind = 'string' | 'number' | 'strings' | 'json';

export interface FieldSpec {
  readonly kind: FieldKind;
  /** The field may be absent (and is then absent when it is opened: no `null`, no empty string made up). */
  readonly optional?: true;
}

// Generic, so that the kind of each field stays the literal it was written as and `SealedFields` can say what each is.
const required = <K extends FieldKind>(kind: K) => ({ kind }) as const;
const optional = <K extends FieldKind>(kind: K) => ({ kind, optional: true }) as const;

export interface TableDeclaration {
  /** The words after `(s)` in the table's row of §24.3: a test finds them there. */
  readonly design: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
  /** The phase that brings the table, for the reader. */
  readonly phase: 1 | 2 | 3;
}

/**
 * What every table seals. `address` is the parts of an address as an object (street, city, region, country, country code, postal code, §7.1); `copy` is the reader's
 * copy of a shared check-in (§15.3); `content` of a notice or an outbox row is what it says and to whom, in the kinds of 12.1 and 12.2.
 */
export const SEALED = {
  profile: {
    design: 'name, email',
    phase: 1,
    fields: { name: required('string'), email: required('string') },
  },
  place: {
    design: 'name, lat, lng, address parts, category, source id',
    phase: 1,
    fields: {
      name: required('string'),
      lat: required('number'),
      lng: required('number'),
      address: optional('json'),
      category: optional('string'),
      sourceId: optional('string'),
    },
  },
  checkin: {
    design: 'note, companions',
    phase: 1,
    fields: { note: optional('string'), companions: optional('strings') },
  },
  import_job: {
    design: 'errors',
    phase: 1,
    fields: { errors: optional('json') },
  },
  notice: {
    design: 'addresses and content',
    phase: 1,
    fields: { content: required('json') },
  },
  mail_outbox: {
    design: 'addresses and content',
    phase: 1,
    fields: { address: required('string'), content: required('json') },
  },
  trip: {
    design: 'name, description',
    phase: 2,
    fields: { name: required('string'), description: optional('string') },
  },
  stop: {
    design: 'note',
    phase: 2,
    fields: { note: optional('string') },
  },
  day: {
    design: 'title, notes',
    phase: 2,
    fields: { title: optional('string'), notes: optional('string') },
  },
  item: {
    design: 'title, notes',
    phase: 2,
    fields: { title: required('string'), notes: optional('string') },
  },
  attachment: {
    design: 'title',
    phase: 2,
    fields: { title: required('string') },
  },
  trip_link: {
    design: 'title, url',
    phase: 2,
    fields: { title: required('string'), url: required('string') },
  },
  shared_checkin: {
    design: "the reader's copy",
    phase: 2,
    fields: { copy: required('json') },
  },
  invitation: {
    design: 'email',
    phase: 2,
    fields: { email: optional('string') },
  },
  push_subscription: {
    design: 'endpoint and keys',
    phase: 3,
    fields: { endpoint: required('string'), keys: required('json') },
  },
} as const satisfies Record<string, TableDeclaration>;

export type SealedTable = keyof typeof SEALED;

type Kinds = { string: string; number: number; strings: string[]; json: unknown };
type Fields<T extends SealedTable> = (typeof SEALED)[T]['fields'];
type IsOptional<S> = S extends { optional: true } ? true : false;

/** The fields of a table as the code sees them: required ones present, optional ones possibly absent. */
export type SealedFields<T extends SealedTable> = {
  [
    K in keyof Fields<T> as IsOptional<Fields<T>[K]> extends true ? never : K
  ]: Kinds[Fields<T>[K] extends { kind: infer Kind extends FieldKind } ? Kind : never];
} & {
  [
    K in keyof Fields<T> as IsOptional<Fields<T>[K]> extends true ? K : never
  ]?: Kinds[Fields<T>[K] extends { kind: infer Kind extends FieldKind } ? Kind : never];
};

/** A value that does not fit what the table declares. Its message names the table and the field, never a value. */
export class SealedFieldError extends Error {
  override name = 'SealedFieldError';
}

const isJson = (value: unknown): boolean => {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
};

function check(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'strings':
      return Array.isArray(value) && value.every((each) => typeof each === 'string');
    case 'json':
      return value !== null && value !== undefined && isJson(value);
  }
}

/** Checks `fields` against the declaration, and returns what is to be sealed: only the declared fields, with the absent ones left out. */
function checked(table: SealedTable, fields: Record<string, unknown>): Record<string, unknown> {
  const declared = SEALED[table].fields as Readonly<Record<string, FieldSpec>>;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(fields)) {
    if (!(name in declared))
      throw new SealedFieldError(`${table} does not seal a field called ${name}`);
  }
  for (const [name, spec] of Object.entries(declared)) {
    const value = fields[name];
    if (value === undefined) {
      if (!spec.optional) throw new SealedFieldError(`${table} seals ${name}, and it is missing`);
      continue;
    }
    if (!check(spec.kind, value))
      throw new SealedFieldError(`${table} seals ${name} as ${spec.kind}, and it is not`);
    out[name] = value;
  }
  return out;
}

/** The binding of a row's envelope: the table is the purpose, so that an envelope moved to another table, or another row, does not open. */
const bindingOf = (table: SealedTable, id: string): Binding => ({ id, purpose: table });

/** Seals and opens the rows of a database, under a ring of keys. The server makes one from the settings (`src/crypto/server.ts`). */
export class Sealer {
  constructor(private readonly ring: KeyRing) {}

  /** The envelope for a row: its sealed fields, as one value, bound to the table and the id. */
  seal<T extends SealedTable>(table: T, id: string, fields: SealedFields<T>): Buffer {
    const plain = Buffer.from(
      JSON.stringify(checked(table, fields as Record<string, unknown>)),
      'utf8',
    );
    return sealBytes(plain, bindingOf(table, id), this.ring.current);
  }

  /** The fields of a row, opened: for the row it was sealed to, and no other. Throws a `CryptoError` for one that does not open. */
  unseal<T extends SealedTable>(table: T, id: string, envelope: Uint8Array): SealedFields<T> {
    const plain = openBytes(envelope, bindingOf(table, id), this.ring);
    const parsed: unknown = JSON.parse(plain.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new SealedFieldError(`${table} holds something that is not its fields`);
    // What was sealed was checked on the way in; what comes out is checked again, so that a row written by another version is not trusted as this one's.
    return checked(table, parsed as Record<string, unknown>) as SealedFields<T>;
  }
}
