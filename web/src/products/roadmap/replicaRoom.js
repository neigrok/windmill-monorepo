// Whether this build's roadmap room reads the device's copy through the sync engine (roadmap-on-the-engine.md §8.4), with
// Settings' export reading it too, and takes its signed-out roadmaps to an account by the engine's lineage rule (§5 Signed
// out): only a build that sets VITE_ROADMAP_REPLICA_ROOM to `on`. Production's build sets nothing, so its room and export
// read, claim and wipe as they do today.
export const ROOM_READS_REPLICA = import.meta.env?.VITE_ROADMAP_REPLICA_ROOM === 'on';
