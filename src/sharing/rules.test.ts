import { describe, expect, it } from 'vitest';
import { type ShareFacts, choiceFor, needsAnswer, sharedWith } from './rules';

const facts = (patch: Partial<ShareFacts> = {}): ShareFacts => ({
  share: 'trip',
  tripId: 'trip-1',
  authorMay: true,
  forTrip: 'ask',
  defaultChoice: 'ask',
  ...patch,
});

describe('who a check-in is shared with', () => {
  it('is nobody until the person has said so: a check-in linked to a trip is private by default', () => {
    expect(sharedWith(facts())).toBeUndefined();
    expect(sharedWith(facts({ forTrip: 'off' }))).toBeUndefined();
  });

  it('follows the trip when the check-in says so, and the person’s choice for it', () => {
    expect(sharedWith(facts({ forTrip: 'on' }))).toBe('trip-1');
    expect(sharedWith(facts({ forTrip: 'ask', defaultChoice: 'on' }))).toBe('trip-1');
    expect(sharedWith(facts({ forTrip: 'off', defaultChoice: 'on' }))).toBeUndefined();
    expect(sharedWith(facts({ forTrip: 'on', defaultChoice: 'off' }))).toBe('trip-1');
  });

  it('is the check-in’s own word when it has one, whatever the trip says', () => {
    expect(sharedWith(facts({ share: 'on', forTrip: 'off' }))).toBe('trip-1');
    expect(sharedWith(facts({ share: 'on' }))).toBe('trip-1');
    expect(sharedWith(facts({ share: 'off', forTrip: 'on', defaultChoice: 'on' }))).toBeUndefined();
  });

  it('needs a trip, and an author who is still an Organizer or a Traveler of it', () => {
    expect(sharedWith(facts({ share: 'on', tripId: null }))).toBeUndefined();
    expect(sharedWith(facts({ share: 'on', authorMay: false }))).toBeUndefined();
    expect(sharedWith(facts({ forTrip: 'on', authorMay: false }))).toBeUndefined();
  });
});

describe('what a choice comes to', () => {
  it('is the person’s own for the trip, then their default, then still to be asked', () => {
    expect(choiceFor('on', 'off')).toBe('on');
    expect(choiceFor('off', 'on')).toBe('off');
    expect(choiceFor('ask', 'on')).toBe('on');
    expect(choiceFor('ask', 'off')).toBe('off');
    expect(choiceFor('ask', 'ask')).toBe('ask');
  });
});

describe('when to ask', () => {
  it('asks once, on a check-in that follows the trip, in a trip with other members, when nothing answers it', () => {
    expect(needsAnswer(facts(), 3)).toBe(true);
    expect(needsAnswer(facts(), 0)).toBe(false);
    expect(needsAnswer(facts({ forTrip: 'on' }), 3)).toBe(false);
    expect(needsAnswer(facts({ forTrip: 'off' }), 3)).toBe(false);
    expect(needsAnswer(facts({ defaultChoice: 'off' }), 3)).toBe(false);
    expect(needsAnswer(facts({ share: 'on' }), 3)).toBe(false);
    expect(needsAnswer(facts({ tripId: null }), 3)).toBe(false);
    expect(needsAnswer(facts({ authorMay: false }), 3)).toBe(false);
  });
});
