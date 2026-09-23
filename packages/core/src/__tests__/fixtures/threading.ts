import type { ThreadingMessage } from '../../threading.js';

export interface ThreadFixture {
  id: string;
  subjectNormalized: string;
}

export const existingThread: ThreadFixture = {
  id: 'thr_project_atlas',
  subjectNormalized: 'project atlas',
};

export const longReplyChain: readonly ThreadingMessage[] = [
  {
    messageId: '<atlas-1@localmail.test>',
    subject: 'Project Atlas',
  },
  {
    messageId: '<atlas-2@localmail.test>',
    inReplyTo: '<atlas-1@localmail.test>',
    references: '<atlas-1@localmail.test>',
    subject: 'Re: Project Atlas',
  },
  {
    messageId: '<atlas-3@localmail.test>',
    inReplyTo: '<atlas-2@localmail.test>',
    references: '<atlas-1@localmail.test> <atlas-2@localmail.test>',
    subject: 'RE: Re: Project Atlas',
  },
  {
    messageId: '<atlas-4@localmail.test>',
    inReplyTo: '<atlas-3@localmail.test>',
    references: [
      '<atlas-1@localmail.test>',
      '<atlas-2@localmail.test>',
      '<atlas-3@localmail.test>',
    ],
    subject: 'Fwd: RE: Re: Project Atlas',
  },
];

export const mismatchedSubjectPrefixes: ThreadingMessage = {
  messageId: '<atlas-forwarded@external.test>',
  subject: ' FWD: re: Project   Atlas ',
};

export const missingReferences: ThreadingMessage = {
  messageId: '<atlas-no-references@external.test>',
  inReplyTo: 'atlas-3@localmail.test',
  subject: 'A changed subject that must not control the match',
};
