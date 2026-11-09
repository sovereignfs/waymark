import { describe, expect, it } from 'vitest';
import { type Relation, canSeeEmail, visibleProfile } from './visibility';

const ada = { accountId: 'a-1', name: 'Ada Lovelace', email: 'ada@example.com' };

describe('what of a profile another person sees (DESIGN.md §6.1)', () => {
  it('gives the person themselves and an Organizer of a trip they are in a name and an email', () => {
    for (const relation of ['self', 'organizer'] as const)
      expect(visibleProfile(ada, relation), relation).toEqual(ada);
  });

  it('gives a member who is not an Organizer a name and no email: a Traveler and a Follower alike', () => {
    const seen = visibleProfile(ada, 'member');
    expect(seen).toEqual({ accountId: 'a-1', name: 'Ada Lovelace' });
    expect('email' in (seen ?? {})).toBe(false);
  });

  it('gives someone who shares nothing with the person nothing at all, which a caller reads as not found', () => {
    expect(visibleProfile(ada, 'none')).toBeUndefined();
  });

  it('says for each relation whether it may see an email, and no other relation does', () => {
    const relations: Relation[] = ['self', 'organizer', 'member', 'none'];
    expect(relations.filter(canSeeEmail)).toEqual(['self', 'organizer']);
  });

  it('never carries anything but the account, the name and what the relation allows', () => {
    const extra = { ...ada, coreSub: 'sub-1', units: 'mi' };
    for (const relation of ['self', 'organizer', 'member'] as const)
      expect(Object.keys(visibleProfile(extra, relation) ?? {}).sort()).toEqual(
        canSeeEmail(relation) ? ['accountId', 'email', 'name'] : ['accountId', 'name'],
      );
  });
});
