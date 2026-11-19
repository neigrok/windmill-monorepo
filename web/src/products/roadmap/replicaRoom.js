// Whether this build's roadmap room reads the device's copy through the sync engine (roadmap-on-the-engine.md §8.4), and
// with it takes its signed-out roadmaps to an account by the engine's lineage rule (§5 Signed out): only a build that sets
// VITE_ROADMAP_REPLICA_ROOM to `on`. Production's build sets nothing, so its room reads, claims and wipes as it does today.
export const ROOM_READS_REPLICA = import.meta.env?.VITE_ROADMAP_REPLICA_ROOM === 'on';
