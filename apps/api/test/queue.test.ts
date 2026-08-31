import { describe, expect, it } from 'vitest';
import { enqueue, waitForIdle } from '../src/lib/queue.js';

describe('queue', () => {
  it('runs jobs one at a time, in order', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(name);
    };

    enqueue('a', slow('a', 30));
    enqueue('b', slow('b', 1));
    enqueue('c', slow('c', 1));
    await waitForIdle();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps draining after a job throws', async () => {
    const done: string[] = [];
    enqueue('boom', async () => {
      throw new Error('deliberate');
    });
    enqueue('after', async () => {
      done.push('after');
    });
    await waitForIdle();
    expect(done).toEqual(['after']);
  });
});
