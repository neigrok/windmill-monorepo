import { useMemo } from 'react';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useSyncReplica } from '../../platform/sync/react.js';

// The room's seat (web-device-parity §2, §3): `signedIn`, an account the shell has settled that the drawn replica is bound
// to, which shares, Coach, Notes and the server's forms stand behind; `anonymous`, the browser's own copy drawn signed out.
export function useGymSeat() {
  const { status, account } = useAuth();
  const replica = useSyncReplica();
  const signedIn = status === 'signed-in' && replica?.state === 'bound' && replica.account === account?.id;
  const anonymous = replica?.state === 'anon';
  return useMemo(() => ({ signedIn, anonymous }), [signedIn, anonymous]);
}
