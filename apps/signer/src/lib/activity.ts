import { api } from './api';
import type { LinkActivityStep } from '@scansign/shared';

/**
 * Tell the console what this page is doing.
 *
 * Fire-and-forget by design: presence is a nicety for the person waiting at
 * the other end, and nothing here may ever slow down or break the signing
 * itself. The heartbeat re-sends the current step so the console's green dot
 * stays lit while the technician is simply reading — a page that only reported
 * transitions would look offline thirty seconds into filling out the form.
 */
let current: LinkActivityStep = 'opened';
let timer: ReturnType<typeof setInterval> | null = null;

const send = (): void => {
  void api('/link/activity', { method: 'POST', json: { step: current } }).catch(() => {
    /* presence only */
  });
};

export const reportStep = (step: LinkActivityStep): void => {
  current = step;
  send();
};

/** Start the heartbeat. Returns the stopper; call it on unmount. */
export const startPresence = (): (() => void) => {
  send();
  timer = setInterval(send, 15_000);
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return stop;
};
