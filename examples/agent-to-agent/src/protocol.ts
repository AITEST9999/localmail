/**
 * Pure message-formatting/parsing for the meeting-negotiation protocol —
 * no I/O, so the negotiation logic is cheap to unit-test in isolation from
 * the SDK/loopback machinery.
 */
export interface Slot {
  id: string;
  label: string;
}

export const PROPOSED_SLOTS: Slot[] = [
  { id: 'slot-1', label: 'Mon 10:00' },
  { id: 'slot-2', label: 'Mon 14:00' },
  { id: 'slot-3', label: 'Tue 09:00' },
];

const CONFIRMATION_MARKER = 'CONFIRMED';
const PROPOSAL_LINE = /^\d+\.\s+(\S+):\s+(.+)$/;
const ACCEPTANCE_LINE = /I can do ([\w-]+)/;

export function formatProposal(slots: Slot[]): string {
  const lines = slots.map((slot, index) => `${index + 1}. ${slot.id}: ${slot.label}`);
  return `Here are three proposed times:\n${lines.join('\n')}\nReply with the slot id you can make.`;
}

export function parseProposal(text: string): Slot[] {
  return text
    .split('\n')
    .map((line) => PROPOSAL_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ id: match[1]!, label: match[2]! }));
}

/** Bob's rule: the first proposed slot that isn't in his hard-coded busy list. */
export function chooseSlot(slots: Slot[], busySlotIds: string[]): Slot | null {
  return slots.find((slot) => !busySlotIds.includes(slot.id)) ?? null;
}

export function formatAcceptance(slot: Slot): string {
  return `I can do ${slot.id}. See you then.`;
}

export function parseAcceptance(text: string): string | null {
  const match = ACCEPTANCE_LINE.exec(text);
  return match ? match[1]! : null;
}

export function formatConfirmation(slot: Slot): string {
  return `Confirmed: ${slot.id} (${slot.label}). ${CONFIRMATION_MARKER}`;
}

export function isConfirmation(text: string): boolean {
  return text.includes(CONFIRMATION_MARKER);
}
