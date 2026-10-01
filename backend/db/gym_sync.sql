-- Gym adoption schema; apply after schema.sql under the migration write freeze.
-- Plain REST Postgres tests require schema.sql's ON DELETE actions and use a different database.

alter table gym_routines
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists born text,
  add column if not exists life_stamp text,
  add column if not exists name_stamp text,
  add column if not exists position_stamp text,
  add column if not exists entries_stamp text,
  add column if not exists created_door_stamp text;
create index if not exists gym_routines_sync_feed on gym_routines (user_id, seq);

alter table gym_exercises
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists born text,
  add column if not exists life_stamp text,
  add column if not exists name_stamp text,
  add column if not exists pattern_stamp text,
  add column if not exists equipment_stamp text,
  add column if not exists step_kg_stamp text,
  add column if not exists aliases_stamp text;
create index if not exists gym_exercises_sync_feed on gym_exercises (created_by, seq);

alter table gym_exercise_names
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists name_stamp text,
  add column if not exists aliases_stamp text;
create index if not exists gym_exercise_names_sync_feed on gym_exercise_names (user_id, seq);

alter table gym_sessions
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists born text,
  add column if not exists life_stamp text,
  add column if not exists routine_id_stamp text,
  add column if not exists history_routine_id_stamp text,
  add column if not exists plan_stamp text,
  add column if not exists started_at_stamp text,
  add column if not exists finished_at_stamp text,
  add column if not exists closed_by_stamp text,
  add column if not exists display_name_stamp text;
create index if not exists gym_sessions_sync_feed on gym_sessions (user_id, seq);

alter table gym_sets
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists born text,
  add column if not exists life_stamp text,
  add column if not exists session_id_stamp text,
  add column if not exists exercise_id_stamp text,
  add column if not exists weight_kg_stamp text,
  add column if not exists reps_stamp text,
  add column if not exists kind_stamp text,
  add column if not exists rpe_stamp text,
  add column if not exists note_stamp text,
  add column if not exists completed_at_stamp text;
create index if not exists gym_sets_sync_feed on gym_sets (user_id, seq);

alter table gym_notes
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists born text,
  add column if not exists life_stamp text,
  add column if not exists title_stamp text,
  add column if not exists body_stamp text,
  add column if not exists ord_stamp text;
create index if not exists gym_notes_sync_feed on gym_notes (user_id, seq);

alter table gym_bodyweight
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists life_stamp text,
  add column if not exists kg_stamp text,
  add column if not exists recorded_at_stamp text;
create index if not exists gym_bodyweight_sync_feed on gym_bodyweight (user_id, seq);

alter table gym_preferences
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists units_stamp text,
  add column if not exists rest_seconds_stamp text,
  add column if not exists rest_sound_stamp text,
  add column if not exists confirm_haptic_stamp text,
  add column if not exists confirm_sound_stamp text;
create index if not exists gym_preferences_sync_feed on gym_preferences (user_id, seq);

alter table gym_proposals
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists born text,
  add column if not exists life_stamp text,
  add column if not exists routine_id_stamp text,
  add column if not exists intent_stamp text,
  add column if not exists proposed_name_stamp text,
  add column if not exists summary_stamp text,
  add column if not exists changes_stamp text,
  add column if not exists door_stamp text,
  add column if not exists connection_stamp text,
  add column if not exists agent_stamp text,
  add column if not exists thread_id_stamp text,
  add column if not exists state_stamp text,
  add column if not exists superseded_by_stamp text,
  add column if not exists settled_at_stamp text;
create index if not exists gym_proposals_sync_feed on gym_proposals (user_id, seq);

alter table gym_notes add column if not exists ord text;
alter table gym_exercise_names alter column name drop not null;
alter table gym_exercise_aliases add column if not exists sync_positions jsonb;
alter table gym_routine_entries
  add column if not exists rest_seconds_present boolean not null default false,
  add column if not exists sets_present boolean not null default false;
alter table gym_routine_entry_sets
  add column if not exists reps_present boolean not null default false,
  add column if not exists weight_kg_present boolean not null default false;
alter table gym_proposal_changes
  add column if not exists before_present boolean not null default false,
  add column if not exists after_present boolean not null default false,
  add column if not exists before_rest_present boolean not null default false,
  add column if not exists after_rest_present boolean not null default false,
  add column if not exists before_sets_present boolean not null default false,
  add column if not exists after_sets_present boolean not null default false;

alter table gym_write_receipts
  add column if not exists sync_kind text,
  add column if not exists sync_args jsonb;
alter table gym_correction_receipts add column if not exists sync_args jsonb;

drop trigger if exists gym_session_routine_identity on gym_sessions;
-- C.1: cross-record writes are checked at commit, without implicit deletion or register changes.
alter table gym_sets drop constraint if exists gym_sets_session_id_fkey;
alter table gym_sets add constraint gym_sets_session_id_fkey
  foreign key (session_id) references gym_sessions(id) deferrable initially deferred;
alter table gym_sets drop constraint if exists gym_sets_exercise_id_fkey;
alter table gym_sets add constraint gym_sets_exercise_id_fkey
  foreign key (exercise_id) references gym_exercises(id) deferrable initially deferred;
alter table gym_routine_entries drop constraint if exists gym_routine_entries_exercise_id_fkey;
alter table gym_routine_entries add constraint gym_routine_entries_exercise_id_fkey
  foreign key (exercise_id) references gym_exercises(id) deferrable initially deferred;
alter table gym_proposal_changes drop constraint if exists gym_proposal_changes_exercise_id_fkey;
alter table gym_proposal_changes add constraint gym_proposal_changes_exercise_id_fkey
  foreign key (exercise_id) references gym_exercises(id) deferrable initially deferred;
alter table gym_sessions drop constraint if exists gym_sessions_routine_id_fkey;
alter table gym_sessions add constraint gym_sessions_routine_id_fkey
  foreign key (routine_id) references gym_routines(id) deferrable initially deferred;
alter table gym_proposals drop constraint if exists gym_proposals_routine_id_fkey;
alter table gym_proposals add constraint gym_proposals_routine_id_fkey
  foreign key (routine_id) references gym_routines(id) deferrable initially deferred;
alter table gym_proposals drop constraint if exists gym_proposals_thread_id_fkey;
alter table gym_proposals add constraint gym_proposals_thread_id_fkey
  foreign key (thread_id) references gym_ask_threads(id) deferrable initially deferred;
alter table gym_exercise_names drop constraint if exists gym_exercise_names_exercise_id_fkey;
alter table gym_exercise_names add constraint gym_exercise_names_exercise_id_fkey
  foreign key (exercise_id) references gym_exercises(id) deferrable initially deferred;
alter table gym_exercise_aliases drop constraint if exists gym_exercise_aliases_exercise_id_fkey;
alter table gym_exercise_aliases add constraint gym_exercise_aliases_exercise_id_fkey
  foreign key (exercise_id) references gym_exercises(id) deferrable initially deferred;
