import { describe, expect, it } from 'vitest';

import {
  PROPOSED_SLOTS,
  chooseSlot,
  formatAcceptance,
  formatConfirmation,
  formatProposal,
  isConfirmation,
  parseAcceptance,
  parseProposal,
} from './protocol.js';

describe('protocol round-trips', () => {
  it('parseProposal reads back exactly what formatProposal wrote', () => {
    const text = formatProposal(PROPOSED_SLOTS);
    expect(parseProposal(text)).toEqual(PROPOSED_SLOTS);
  });

  it('parseAcceptance reads back the slot id from formatAcceptance', () => {
    const text = formatAcceptance(PROPOSED_SLOTS[1]!);
    expect(parseAcceptance(text)).toBe('slot-2');
  });

  it('parseAcceptance returns null when there is no acceptance line', () => {
    expect(parseAcceptance('no slot mentioned here')).toBeNull();
  });

  it('isConfirmation recognizes formatConfirmation output', () => {
    expect(isConfirmation(formatConfirmation(PROPOSED_SLOTS[0]!))).toBe(true);
  });

  it('isConfirmation is false for a plain acceptance', () => {
    expect(isConfirmation(formatAcceptance(PROPOSED_SLOTS[0]!))).toBe(false);
  });
});

describe('chooseSlot — Bob only accepts a free slot', () => {
  it('picks the first slot not in the busy list', () => {
    expect(chooseSlot(PROPOSED_SLOTS, ['slot-1'])).toEqual(PROPOSED_SLOTS[1]);
  });

  it('picks the first slot when none are busy', () => {
    expect(chooseSlot(PROPOSED_SLOTS, [])).toEqual(PROPOSED_SLOTS[0]);
  });

  it('returns null when every proposed slot is busy', () => {
    expect(chooseSlot(PROPOSED_SLOTS, PROPOSED_SLOTS.map((s) => s.id))).toBeNull();
  });
});
