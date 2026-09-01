import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RealtimeEvent } from '@scansign/shared';
import { connectRealtime } from './realtime';

/**
 * Refresh the affected queries the moment the backend says something changed,
 * instead of waiting for the next poll.
 *
 * The polling in `queries.ts` stays as it is: it is the safety net for a socket
 * that is down, behind a proxy that strips upgrades, or simply not yet
 * reconnected. Live updates make the console feel immediate; polling makes it
 * correct regardless.
 */
export const useRealtime = (): { connected: boolean } => {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const invalidate = (...keys: string[]) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    };

    const handle = (event: RealtimeEvent) => {
      switch (event.type) {
        case 'folder.shared':
        case 'folder.updated':
        case 'folder.deleted':
          invalidate('folders', 'folder', 'dashboard', 'activity');
          break;
        case 'document.updated':
          invalidate('folder', 'folders', 'dashboard', 'activity');
          break;
        case 'session.updated':
          invalidate('folder', 'folders', 'dashboard', 'activity');
          break;
      }
    };

    return connectRealtime(handle, setConnected);
  }, [queryClient]);

  return { connected };
};
