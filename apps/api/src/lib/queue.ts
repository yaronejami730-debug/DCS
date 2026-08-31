/**
 * A one-at-a-time in-process job runner.
 *
 * Deliberately not a message broker. Signature processing is seconds long and
 * low volume; the durable state lives in Postgres (`signing_sessions.status`),
 * so a restart mid-job leaves a row in 'processing' that the console shows as
 * stuck rather than losing work silently. Swap this for a real queue only when
 * throughput actually demands it.
 */
type Job = () => Promise<void>;

const pending: Array<{ name: string; job: Job }> = [];
let draining = false;

const drain = async (): Promise<void> => {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const next = pending.shift()!;
      try {
        await next.job();
      } catch (error) {
        // Jobs own their own failure handling; this is the last-resort net.
        console.error('[queue] job %s threw: %s', next.name, error);
      }
    }
  } finally {
    draining = false;
  }
};

export const enqueue = (name: string, job: Job): void => {
  pending.push({ name, job });
  void drain();
};

/** Test helper: resolve once the queue is empty. */
export const waitForIdle = async (): Promise<void> => {
  while (pending.length > 0 || draining) {
    await new Promise((r) => setTimeout(r, 10));
  }
};
