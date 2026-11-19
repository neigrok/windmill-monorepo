-- Roadmap's own tables as production holds them, one case of Roadmap on the sync engine §8.1 a row, for
-- roadmap_adopt_test.py. Loaded after db/schema.sql, which seeds the public demo. Three accounts own roadmaps: `owner`,
-- `reader` and `scribbler`, whose roadmaps hold the stamps the old server cannot read; `gone` owned one and no longer
-- exists. Stamps are ms:counter:actor around 1 740 000 000 000; the roadmaps were made at 1 735 689 600 000 and last
-- changed at 1 748 736 000 000.

insert into users (id, email, name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'owner@example.com', 'Owner'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'reader@example.com', 'Reader'),
  ('cccccccc-0000-4000-8000-00000000000c', 'scribbler@example.com', 'Scribbler');

-- The roots, then the subtrees, parents first: trees_place takes a subtree's root, depth and owner from its parent's row.
insert into trees (id, owner_id, title, title_hlc, guide, guide_hlc, guide_inherited, visibility, head_seq, forked_from,
                   created_at, updated_at)
values
  -- every register rule and record's life the old server reads; its head below its activity's last seq
  ('t_a000000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Learn the cello', '', 'Practise daily', '1740000000000:0:r_owner',
   true, 'public', 7, 't_b000000000000001', to_timestamp(1735689600), to_timestamp(1748736000)),
  -- a private root a pointer opens
  ('t_a000000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Read music', '1740000000000:1:r_owner', '', '', false,
   'private', 0, null, to_timestamp(1735689600), to_timestamp(1748736000)),
  -- a root that will be deleted, with a subtree of its own
  ('t_a000000000000005', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Abandoned', '', '', '', false, 'public', 2, null,
   to_timestamp(1735689600), to_timestamp(1748736000)),
  -- a roadmap stored only as a whole document
  ('t_a000000000000007', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Old document', '1740000000000:0:r_owner', '', '', false,
   'unlisted', 3, null, to_timestamp(1735689600), to_timestamp(1748736000)),
  -- the reader's own unlisted roadmap, which the owner marks
  ('t_b000000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'Bake bread', '1740000000000:0:r_reader', '', '', false,
   'unlisted', 1, null, to_timestamp(1735689600), to_timestamp(1748736000)),
  -- a roadmap nobody owns, which the move is told to expect
  ('t_c000000000000001', null, 'Nobody''s', '', '', '', false, 'public', 0, null, to_timestamp(1735689600),
   to_timestamp(1748736000)),
  -- a roadmap of an account that is gone, which the move is told to expect
  ('t_d000000000000001', 'dddddddd-0000-4000-8000-00000000000d', 'Orphan', '', '', '', false, 'private', 0, null,
   to_timestamp(1735689600), to_timestamp(1748736000)),
  -- the scribbler's roadmaps: malformed stamps in rows, and in a whole document
  ('t_e000000000000001', 'cccccccc-0000-4000-8000-00000000000c', 'Scribbles', 'not a stamp', '', '', false, 'unlisted', 0, null,
   to_timestamp(1735689600), to_timestamp(1748736000)),
  ('t_e000000000000002', 'cccccccc-0000-4000-8000-00000000000c', 'Scribbled document', '', '', '', false, 'private', 0, null,
   to_timestamp(1735689600), to_timestamp(1748736000));

insert into tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, present) values
  ('t_a000000000000001', 'owning', '1740000000000:10:r_owner', '', true),
  ('t_a000000000000005', 'gone-owning', '1740000000000:0:r_owner', '', true);
insert into trees (id, title, parent_tree, parent_step, created_at, updated_at) values
  ('t_a000000000000002', '', 't_a000000000000001', 'owning', to_timestamp(1735689600), to_timestamp(1748736000)),
  ('t_a000000000000006', '', 't_a000000000000005', 'gone-owning', to_timestamp(1735689600), to_timestamp(1748736000));
insert into tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, present) values
  ('t_a000000000000002', 'deep-owning', '1740000000000:1:r_owner', '1740000000001:0:r_owner', false);
insert into trees (id, title, parent_tree, parent_step, created_at, updated_at) values
  ('t_a000000000000004', '', 't_a000000000000002', 'deep-owning', to_timestamp(1735689600), to_timestamp(1748736000));
update trees set deleted_at = to_timestamp(1747000000) where id = 't_a000000000000005';

-- The steps of the first root: kept, unset and future stamps; life from each pair of stamps and from neither; an empty
-- and a malformed order key; statuses; an unknown colour; a pointer, a cleared one, and the step owning a subtree.
update tree_nodes set label = 'Strings', label_hlc = '1740000000000:10:r_owner', ord = 'a0', ord_hlc = '1740000000000:10:r_owner'
  where tree_id = 't_a000000000000001' and node_id = 'owning';
insert into tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, ord, ord_hlc,
                        status, status_hlc, description, description_hlc, links, links_hlc, opens, opens_hlc, present)
values
  ('t_a000000000000001', 'kept', '1740000000000:1:r_owner', '', 'Hold the bow', '1740000000000:2:r_owner', 'music',
   '1740000000000:2:r_owner', 'olive', '1740000000000:2:r_owner', 'a1', '1740000000000:2:r_owner', 'complete',
   '1740000000000:2:r_owner', 'Thumb bent', '1740000000000:2:r_owner',
   '[{"url": "https://example.com/bow", "label": "Bow hold"}, "https://example.com/bare"]', '1740000000000:2:r_owner', '', '',
   true),
  ('t_a000000000000001', 'unset', '1740000000000:3:r_owner', '', 'Tune', '', '', '', 'terracotta', '', 'a2', '', null, '0:0:', '',
   '', '[]', '', '', '', true),
  ('t_a000000000000001', 'future', '1740000000000:5:r_owner', '', 'Vibrato', '9999999999999:0:r_owner', '', '', 'terracotta', '',
   'a4', '1740000000000:5:r_owner', null, '', '', '', '[]', '', '', '', true),
  ('t_a000000000000001', 'dead', '1740000000000:6:r_owner', '1740000000001:6:r_owner', 'Dropped', '1740000000000:6:r_owner', '',
   '', 'terracotta', '', 'a5', '1740000000000:6:r_owner', null, '', '', '', '[]', '', '', '', false),
  ('t_a000000000000001', 'revived', '1740000000002:7:r_owner', '1740000000001:7:r_owner', 'Back', '1740000000002:7:r_owner', '',
   '', 'terracotta', '', 'a6', '1740000000002:7:r_owner', null, '', '', '', '[]', '', '', '', true),
  ('t_a000000000000001', 'removed-only', '', '1740000000001:8:r_owner', 'Never added', '1740000000001:8:r_owner', '', '',
   'terracotta', '', 'a7', '1740000000001:8:r_owner', null, '', '', '', '[]', '', '', '', false),
  ('t_a000000000000001', 'neither', '', '', 'Ghost', '1740000000001:9:r_owner', '', '', 'terracotta', '', 'a8', '', null, '', '',
   '', '[]', '', '', '', false),
  ('t_a000000000000001', 'empty-ord', '1740000000000:0:r_owner', '', 'First of all', '1740000000000:0:r_owner', '', '',
   'terracotta', '', '', '', null, '', '', '', '[]', '', '', '', true),
  ('t_a000000000000001', 'bad-ord', '1740000000000:11:r_owner', '', 'Between', '1740000000000:11:r_owner', '', '', 'terracotta',
   '', 'a5V!', '1740000000000:11:r_owner', null, '', '', '', '[]', '', '', '', true),
  ('t_a000000000000001', 'active', '1740000000000:12:r_owner', '', 'Was active', '1740000000000:12:r_owner', '', '', 'mauve',
   '1740000000000:12:r_owner', 'a9', '1740000000000:12:r_owner', 'active', '1740000000000:12:r_owner', '', '', '[]', '', '', '',
   true),
  ('t_a000000000000001', 'opener', '1740000000000:13:r_owner', '', 'Theory', '1740000000000:13:r_owner', '', '', 'sky', '',
   'aA', '1740000000000:13:r_owner', null, '', '', '', '[]', '', 't_a000000000000003', '1740000000000:14:r_owner', true),
  ('t_a000000000000001', 'cleared', '1740000000000:15:r_owner', '', 'Was a pointer', '1740000000000:15:r_owner', '', '',
   'terracotta', '', 'aB', '1740000000000:15:r_owner', null, '', '', '', '[]', '', '', '1740000000000:16:r_owner', true),
  ('t_a000000000000001', 'late', '1740000000000:17:r_owner', '', 'Edited after the last change', '1750000000000:0:r_owner', '', '',
   'terracotta', '', 'aC', '1740000000000:17:r_owner', null, '', '', '', '[]', '', '', '', true);

-- Its links: kept, removed, to and from an id no step holds, from a step to itself, from a step no row adopts, and one
-- whose stamps are both unset.
insert into tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) values
  ('t_a000000000000001', 'kept', 'unset', '1740000000000:20:r_owner', ''),
  ('t_a000000000000001', 'owning', 'kept', '1740000000000:21:r_owner', ''),
  ('t_a000000000000001', 'kept', 'future', '1740000000000:22:r_owner', '1740000000001:22:r_owner'),
  ('t_a000000000000001', 'kept', 'missing', '1740000000000:23:r_owner', ''),
  ('t_a000000000000001', 'missing', 'kept', '1740000000000:24:r_owner', ''),
  ('t_a000000000000001', 'kept', 'kept', '1740000000000:25:r_owner', ''),
  ('t_a000000000000001', 'neither', 'kept', '1740000000000:26:r_owner', ''),
  ('t_a000000000000001', 'unset', 'future', '', '');

-- Its kinds by rank, one under an unset rank stamp and one deleted.
insert into tree_kinds (tree_id, kind_id, created_hlc, deleted_hlc, hue, hue_hlc, label, label_hlc, description, description_hlc,
                        rank, rank_hlc)
values
  ('t_a000000000000001', 'build', '1740000000000:0:r_owner', '', 'terracotta', '1740000000000:0:r_owner', 'Build',
   '1740000000000:0:r_owner', 'Things you make', '1740000000000:0:r_owner', 1, '1740000000000:0:r_owner'),
  ('t_a000000000000001', 'learn', '1740000000000:0:r_owner', '', 'olive', '1740000000000:0:r_owner', 'Learn',
   '1740000000000:0:r_owner', '', '', 0, '1740000000000:0:r_owner'),
  ('t_a000000000000001', 'later', '1740000000000:0:r_owner', '', 'sky', '1740000000000:0:r_owner', 'Later', '', '', '', 5, ''),
  ('t_a000000000000001', 'gone', '1740000000000:0:r_owner', '1740000000001:0:r_owner', 'plum', '1740000000000:0:r_owner',
   'Gone', '1740000000000:0:r_owner', '', '', 2, '1740000000000:0:r_owner');

-- Marks: the owner's, out of order, active and none under no stamp; the reader's; one of no account; one on a step no
-- row holds; the owner's on the reader's roadmap; one on a deleted roadmap.
insert into node_progress (tree_id, user_id, node_id, status, out_of_order, hlc, updated_at) values
  ('t_a000000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'kept', 'complete', true, '1740000000000:30:r_owner',
   to_timestamp(1741000000)),
  ('t_a000000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'unset', 'active', false, '1740000000000:31:r_owner',
   to_timestamp(1741000001)),
  ('t_a000000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'future', 'none', false, '', to_timestamp(1741000003)),
  ('t_a000000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'kept', 'complete', false, '1740000000000:32:r_reader',
   to_timestamp(1741000004)),
  ('t_a000000000000001', 'dev', 'kept', 'complete', false, '1740000000000:33:dev', to_timestamp(1741000005)),
  ('t_a000000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'nowhere', 'complete', false, '1740000000000:34:r_owner',
   to_timestamp(1741000006)),
  ('t_b000000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'knead', 'complete', false, '1740000000000:35:r_owner',
   to_timestamp(1741000007)),
  ('t_a000000000000005', 'aaaaaaaa-0000-4000-8000-00000000000a', 'gone-step', 'complete', false, '1740000000000:50:r_owner',
   to_timestamp(1741000008));

-- Its activity, two lines past its head, as the rooms wrote them.
insert into tree_ops (tree_id, seq, actor_id, op_id, kind, payload, hlc, created_at) values
  ('t_a000000000000001', 8, 'aaaaaaaa-0000-4000-8000-00000000000a', 'op-8', 'CreateNode',
   '{"id": "kept", "label": "Hold the bow", "icon": "music", "color": "olive"}', '1740000000000:1:r_owner', to_timestamp(1740000000)),
  ('t_a000000000000001', 9, 'aaaaaaaa-0000-4000-8000-00000000000a', 'op-9', 'RenameNode', '{"id": "unset", "label": "Tune"}',
   '1740000000000:3:r_owner', to_timestamp(1740000001));

insert into tree_og_images (tree_id, png) values ('t_a000000000000001', '\x89504e47');
insert into tree_og_videos (tree_id, video) values ('t_a000000000000001', '\x00000020');

-- The subtree at depth 1, which stands, its own subtree at depth 2, hidden by its owning step's death, and the steps of
-- the other roadmaps.
insert into tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, ord, ord_hlc, present) values
  ('t_a000000000000002', 'open-strings', '1740000000000:40:r_owner', '', 'Open strings', '1740000000000:40:r_owner', 'a0',
   '1740000000000:40:r_owner', true),
  ('t_a000000000000004', 'hidden-step', '1740000000000:41:r_owner', '', 'Hidden', '1740000000000:41:r_owner', 'a0',
   '1740000000000:41:r_owner', true),
  ('t_a000000000000003', 'notes', '1740000000000:42:r_owner', '', 'Notes', '1740000000000:42:r_owner', 'a0',
   '1740000000000:42:r_owner', true),
  ('t_a000000000000005', 'gone-step', '1740000000000:43:r_owner', '', 'Gone', '1740000000000:43:r_owner', '', '', true),
  ('t_a000000000000006', 'gone-below', '1740000000000:44:r_owner', '', 'Gone below', '1740000000000:44:r_owner', '', '', true),
  ('t_b000000000000001', 'knead', '1740000000000:45:r_reader', '', 'Knead', '1740000000000:45:r_reader', 'a0',
   '1740000000000:45:r_reader', true),
  ('t_b000000000000001', 'proof', '1740000000000:46:r_reader', '', 'Proof', '1740000000000:46:r_reader', 'a1',
   '1740000000000:46:r_reader', true),
  ('t_b000000000000001', 'late', '1740000000000:51:r_reader', '', 'Renamed after the last change', '1750000000000:0:r_reader',
   'a2', '1740000000000:51:r_reader', true),
  ('t_c000000000000001', 'alone', '1740000000000:47:srv', '', 'Alone', '1740000000000:47:srv', '', '', true),
  ('t_d000000000000001', 'orphaned', '1740000000000:48:r_gone', '', 'Orphaned', '1740000000000:48:r_gone', 'a0',
   '1740000000000:48:r_gone', true);
insert into tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) values
  ('t_b000000000000001', 'knead', 'proof', '1740000000000:49:r_reader', '');

-- The scribbler's rows: a step born under a malformed stamp, registers under malformed ones, and a mark under one.
insert into tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, color, color_hlc, ord, ord_hlc, present)
values
  ('t_e000000000000001', 'malformed', 'x1740000000000:4:r_owner', '', 'Scales', 'not a stamp', 'gold', '01:0:r_owner', 'a3',
   '1740000000000:4:', true),
  ('t_e000000000000001', 'kept', '1740000000000:5:r_scribbler', '', 'Arpeggios', '1740000000000:5:r_scribbler', 'olive',
   '1740000000000:5:r_scribbler', 'a4', '1740000000000:5:r_scribbler', true);
insert into tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) values
  ('t_e000000000000001', 'malformed', 'kept', '1740000000000:6:r_scribbler', 'gone');
insert into node_progress (tree_id, user_id, node_id, status, out_of_order, hlc, updated_at) values
  ('t_e000000000000001', 'cccccccc-0000-4000-8000-00000000000c', 'malformed', 'complete', false, 'bad', to_timestamp(1741000002));

-- The whole documents: two steps, a link and a kind; and one whose label carries a stamp that is no text.
update trees set document = '{
  "nodes": [
    {"id": "one", "createdAt": "1740000000000:60:r_owner", "deletedAt": "0:0:", "label": "One", "labelAt": "1740000000000:60:r_owner",
     "color": "gold", "colorAt": "1740000000000:60:r_owner", "order": "a0", "orderAt": "1740000000000:60:r_owner",
     "links": [{"url": "https://example.com/one", "label": "One"}], "linksAt": "1740000000000:60:r_owner"},
    {"id": "two", "createdAt": "1740000000000:61:r_owner", "label": "Two", "labelAt": "1740000000000:61:r_owner",
     "status": "inProgress", "statusAt": "1740000000000:61:r_owner", "opens": "t_a000000000000003",
     "opensAt": "1740000000000:62:r_owner"}
  ],
  "edges": [{"from": "one", "to": "two", "addedAt": "1740000000000:63:r_owner", "removedAt": ""}],
  "kinds": [{"id": "build", "createdAt": "1740000000000:64:r_owner", "hue": "gold", "hueAt": "1740000000000:64:r_owner",
             "label": "Build", "labelAt": "1740000000000:64:r_owner", "rank": 0, "rankAt": "1740000000000:64:r_owner"}]
}' where id = 't_a000000000000007';
update trees set document = '{
  "nodes": [{"id": "only", "createdAt": "1740000000000:70:r_scribbler", "label": "Only", "labelAt": 17}]
}' where id = 't_e000000000000002';

-- Each title's and guide's stamp split as the old server's save keeps it beside the text, so its guard runs in SQL.
update trees set title_ms = split_part(title_hlc, ':', 1)::bigint, title_counter = split_part(title_hlc, ':', 2)::bigint
  where title_hlc ~ '^[0-9]+:[0-9]+:.';
update trees set guide_ms = split_part(guide_hlc, ':', 1)::bigint, guide_counter = split_part(guide_hlc, ':', 2)::bigint
  where guide_hlc ~ '^[0-9]+:[0-9]+:.';
