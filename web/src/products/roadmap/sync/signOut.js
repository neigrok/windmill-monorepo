// What signing out takes from this browser of the room on the device's copy (§6), beyond what the engine's own sign-out
// lets go: every roadmap's landing note, in each replica the device holds (Keep leaves the account's dormant replica
// with its device rows, Discard deletes it), and the ids of the notices this browser told the intake of. No engine API
// reaches a dormant replica, so it writes the device's store itself, as `forgetDeviceTrees` does the lattice's. Roadmap's
// `forgetDevice` runs it after the engine's sign-out; the shell names no product.

import { syncSession } from '../../../platform/sync/session.js';
import { RoadmapScopes } from '../domain/roadmapRules.js';
import { forgetToldNotices } from '../kept/toldNotices.js';

export async function forgetReplicaRoom(engine = syncSession.engine) {
  forgetToldNotices();
  if (!engine) return;
  await engine.write(null, (device) => {
    for (const replica of device.replicas) {
      const rows = replica.deviceRows('roadmap');
      for (const key of Object.keys(rows)) if (RoadmapScopes.isLanding(key)) delete rows[key];
    }
  });
}
