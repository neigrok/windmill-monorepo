#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {

// --- Tool schema builders (JSON Schema for each tool's `inputSchema`). ---------------

Json::Value str(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "string";
  property["description"] = description;
  return property;
}

// A string with a published cap: the domain refuses past it either way, and a client can only
// pre-validate what the schema states.
Json::Value cappedStr(const char* description, std::size_t limit) {
  Json::Value property = str(description);
  property["maxLength"] = static_cast<Json::UInt64>(limit);
  return property;
}

Json::Value num(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "number";
  property["description"] = description;
  return property;
}

// A field the READS put on an object, declared on a write that takes the same object back so
// `additionalProperties: false` refuses typos rather than the document we emitted. Ignored on input.
Json::Value ignoredObject(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "object";
  property["description"] = description;
  return property;
}

Json::Value boolean(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "boolean";
  property["description"] = description;
  return property;
}

Json::Value enumStr(const char* description, const std::vector<const char*>& values) {
  Json::Value property = str(description);
  Json::Value allowed(Json::arrayValue);
  for (const char* value : values) allowed.append(value);
  property["enum"] = allowed;
  return property;
}

Json::Value boundedInt(const char* description, int smallest, int largest) {
  Json::Value property(Json::objectValue);
  property["type"] = "integer";
  property["description"] = description;
  property["minimum"] = smallest;
  property["maximum"] = largest;
  return property;
}

// Every instant on this surface is epoch milliseconds inside (0, kMaxInstantMs], the band the
// domain accepts.
Json::Value instant(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "integer";
  property["description"] = description;
  property["minimum"] = 1;
  property["maximum"] = static_cast<Json::Int64>(kMaxInstantMs);
  return property;
}

// The three handles, canonical wherever a tool names something that already exists.
Json::Value sessionHandle() {
  return str("The workout's id — list_sessions answers with it.");
}

Json::Value exerciseHandle() {
  return str("The movement's id — list_exercises answers with it.");
}

Json::Value routineHandle() {
  return str("The routine's id — list_routines answers with it.");
}

// One line of a routine, as the two tools that carry a document take it. Every bound here must be
// the DOMAIN's own (products/gym/domain/Routine.cpp): a schema advertising a wider band than the
// entity accepts invites a value it then refuses the whole document over.
Json::Value entryArray() {
  Json::Value fields(Json::objectValue);
  fields["exerciseId"] = exerciseHandle();
  fields["targetSets"] =
      boundedInt("How many sets this line calls for (1–20). OMIT to leave the line OPEN — the "
                 "movement is in the day and what to do with it is decided at the rack. An open "
                 "line names no reps and no weight either.",
                 1, 20);
  fields["targetReps"] =
      boundedInt("Reps per set (1–100). OMIT to mean `max` — as many as you can.", 1, 100);
  fields["targetWeightKg"] = num("Target load in kg. Omit to mean whatever you did last time.");
  fields["restSeconds"] =
      boundedInt("Rest between sets, 15–900. Omit to fall back to the global rest target they set "
                 "in the app, and to no timer at all when they have set none.",
                 15, 900);
  // list_routines writes a position on every line, so a document read and sent back carries it.
  // Ignored on the way in; the run is renumbered from the order.
  fields["position"] = boundedInt("Ignored — the order these arrive in IS the order.", 1, 10000);

  Json::Value entry(Json::objectValue);
  entry["type"] = "object";
  entry["properties"] = fields;
  // The movement is the only thing a line cannot do without: a routine is savable while incomplete.
  Json::Value required(Json::arrayValue);
  required.append("exerciseId");
  entry["required"] = required;
  // The parser refuses a misspelled field inside an entry, so the schema says so.
  entry["additionalProperties"] = false;

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = entry;
  property["minItems"] = 1;
  property["maxItems"] = static_cast<Json::UInt64>(kMaxRoutineEntries);
  property["description"] =
      "The lines of the day, in order — their order IS the routine's order and positions are "
      "assigned 1..n from it. At least one, at most 50.";
  return property;
}

// Each tool names the grant level that reaches it beside its description, so a client cannot be told
// one thing and gated on another. `read` answers questions; `write` RECORDS what happened, PROPOSES
// changes to the program and mints a coach link; `delete` takes away something a lifter LIVED and
// proposes the destruction of a day of their program. `delete` is never implied by `write`: a
// connection without that level does not so much as see those three.
ToolDeclaration tool(const char* name, Access access, const char* description, Json::Value properties,
                     std::vector<const char*> required) {
  Json::Value schema(Json::objectValue);
  schema["type"] = "object";
  schema["properties"] = std::move(properties);
  Json::Value req(Json::arrayValue);
  for (const char* field : required) req.append(field);
  schema["required"] = req;
  schema["additionalProperties"] = false;

  Json::Value descriptor(Json::objectValue);
  descriptor["name"] = name;
  descriptor["description"] = description;
  descriptor["inputSchema"] = schema;
  return ToolDeclaration{std::move(descriptor), "gym", access};
}

}  // namespace

// Reads, then writes, then deletes, so a narrower grant sees a PREFIX of this list rather than a
// list with holes in it. tools/list is the biggest fixed cost of a connection, so a tool a parameter
// on another tool could serve does not get a slot: routines list and read are one, the finish
// readout rides on the session read, and pending proposals ride on list_routines.
//
// Three verbs have no tool at any level: editing a logged set, saying what a gym owns, and APPLYING
// A PROPOSAL. Apply is a human act, not a capability.
// A write that RECORDS something that already happened lands immediately, so `create_routine`
// writes; a write that CHANGES something that already stands mints a proposal and lands nothing, so
// `propose_routine_change` and `propose_routine_removal` write nothing at all.
std::vector<ToolDeclaration> gymToolCatalog() {
  std::vector<ToolDeclaration> tools;

  {
    tools.push_back(tool("list_exercises", Access::read,
        "The movement catalog you log against: the seeded movements plus the ones you created. Each "
        "row is {id, name, pattern, equipment, stepKg, custom}, and that `id` is the `exerciseId` "
        "every set and routine entry names. Takes no arguments.",
        Json::Value(Json::objectValue), {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["before"] = instant("Page from the previous page's LAST row: its `startedAt`.");
    p["beforeId"] = str("That same row's `id`. Send it with `before` — an id alone names no row.");
    p["limit"] = boundedInt("How many workouts (default 20).", 1, kMaxLogLimit);
    tools.push_back(tool("list_sessions", Access::read,
        "Your training log, newest first — one row per workout: the session, `setCount` (every set "
        "it held) beside `workingSetCount` (only the working ones, which are the only sets that "
        "count toward anything), `tonnageKg` (the load those working sets moved, an assisted or "
        "bodyweight set contributing zero — so a zero tonnage is not a claim that nothing was "
        "done), which movements were in it, its heaviest working set, `topE1rm` (the best Epley "
        "estimate any working set in it earned — the session's own number, not the heaviest set's), "
        "`record` (a personal record happened in that workout — best e1RM, most reps at a load, or "
        "the heaviest load, judged against the log as it stands now, and false on around 190 rows "
        "in 200), and `closedItself` (the four-hour rule ended it rather than a "
        "tap). Page with BOTH halves of the last row's key, `before` and `beforeId`, because two "
        "workouts can start in the same millisecond.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["sessionId"] = sessionHandle();
    p["review"] = boolean("Add the finish readout to the reply (default false).");
    tools.push_back(tool("get_session", Access::read,
        "One workout of yours with every set in it, in the order they were logged. With "
        "`review: true` the reply also carries the finish readout — duration, working sets, top "
        "e1RM, at most one record, and the comparison against the last time you trained that day of "
        "the program.",
        p, {"sessionId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["exerciseId"] = exerciseHandle();
    tools.push_back(tool("last_time", Access::read,
        "What you did the last time you trained one movement: that workout, the day of the program "
        "it was on, and its sets of that movement — the numbers a logger prefills. A movement you "
        "have never trained answers with the movement and nothing else, which is a fact rather than "
        "an error.",
        p, {"exerciseId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["routineId"] = str("Narrow to one routine. Omitted, every routine you own.");
    tools.push_back(tool("list_routines", Access::read,
        "Your program: each routine with its entries, most recently trained first. An entry with no "
        "`targetReps` means `max` — as many as you can — and is omitted rather than zero, which is a "
        "rep target this product can express and a zero could not. `revision` is the routine's "
        "version; read it and never send it. `pendingProposal` is present ONLY while a change is "
        "waiting for the lifter to tap Apply — the newest one, from any connection or from the app's "
        "own Ask; its `source` says whose. Read it before you propose anything: a new proposal of "
        "yours on that routine replaces the one YOU already have waiting there and leaves another "
        "agent's standing.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["exerciseId"] = str("Narrow to one movement's line. Omitted, every movement you have trained.");
    tools.push_back(tool("get_stats", Access::read,
        "The long view over your FINISHED workouts: sessions and working sets per week (Monday to "
        "Monday, UTC — a week you did not train is present and zero), and per movement its line of "
        "top working sets with an Epley e1RM where one is defined, its best e1RM, its heaviest set, "
        "and when it was last trained. Narrow with `exerciseId`; the whole answer is long. There is "
        "no volume, no score and no streak here — every number is a fact with a direction.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = str("The id YOU mint for this workout (`ses_` + hex is the house shape).");
    p["startedAt"] = instant("When the workout began, epoch ms — a real instant, never one ahead of now (a start in the future is refused).");
    p["joinOpenSession"] = boolean("Default true: join whatever session is open instead of failing.");
    p["routineId"] = str("The day of the program this is. Omitted, the workout is ad-hoc.");
    tools.push_back(tool("start_session", Access::write,
        "Open a workout. YOU mint `id` and it IS the idempotency key for the workout this CREATES: "
        "send the same id again and the stored workout comes back — never invent a new id to retry, "
        "that mints a second workout. By default this JOINS a session already open (that is how a "
        "handoff between devices works), and a join answers with THAT workout under ITS OWN id, "
        "leaving yours unspent: log into the id the reply carries, and do not resend this start "
        "once that workout has ended — with nothing open, the same id would then create a new one. "
        "Send `joinOpenSession: false` to mean \"create exactly this one, which is not now\" — a "
        "backfill. A named `routineId` is frozen onto the workout as a copy.",
        p, {"id", "startedAt"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["sessionId"] = sessionHandle();
    p["id"] = str("The id YOU mint for this set (`set_` + hex is the house shape).");
    p["exerciseId"] = exerciseHandle();
    p["weightKg"] = num("Load in kg. Negative is legal — that is band-assisted work.");
    p["reps"] = boundedInt("Reps completed (1–500).", 1, 500);
    p["completedAt"] = instant("When the set was completed, epoch ms.");
    p["kind"] = enumStr("Default working. Warmups, drops and failures count toward nothing.", kSetKinds);
    p["rpe"] = num("Rated exertion, 1–10. Omit if it was not rated.");
    p["note"] = cappedStr("A free note on this set.", 4000);
    tools.push_back(tool("log_set", Access::write,
        "Log one set into an open workout. YOU mint `id` and it IS the idempotency key: resending "
        "the same id answers with the stored row and its set number, so a retry can never duplicate "
        "a set — never mint a fresh id for a retry. The set number is the server's to assign.",
        p, {"sessionId", "id", "exerciseId", "weightKg", "reps", "completedAt"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["sessionId"] = sessionHandle();
    p["finishedAt"] = instant("When the workout ended, epoch ms — at or after it started.");
    tools.push_back(tool("finish_session", Access::write,
        "Close a workout. A finish is permanent: a workout already finished by a tap answers with "
        "the end it already has. A workout the FOUR-HOUR RULE closed (at its last set, because "
        "nothing more arrived) still takes this finish as the lifter's word: within four hours of "
        "that last set the end moves to it; later than that the end stays at the last set and only "
        "the word changes — a tap hours after the bar is not five hours under it.",
        p, {"sessionId", "finishedAt"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = str("The id YOU mint for this NEW routine (`rt_` + hex is the house shape).");
    p["name"] = cappedStr("What this day of the program is called.", kMaxNameLength);
    p["position"] = boundedInt("Where it sits in the program, from 0.", 0, 10000);
    // The three fields list_routines puts on a routine, declared so a document read and sent back
    // under a fresh id is not refused. All three are the STORE's answer: ignored on the way in.
    p["lastTrainedAt"] = num("Ignored — the log decides when a routine was last trained.");
    p["revision"] = num("Ignored — the store moves a routine's revision; a client reads it, never "
                        "sends it.");
    p["pendingProposal"] =
        ignoredObject("Ignored — a proposal belongs to the routine it was minted against and is "
                      "never carried onto a new one.");
    p["entries"] = entryArray();
    tools.push_back(tool("create_routine", Access::write,
        "Add a NEW day to the program. This one LANDS IMMEDIATELY, and that is the rule rather than "
        "an exception: a day that did not exist takes nothing away, the lifter sees it the next time "
        "they open Routines, and they can edit or delete it themselves. Changing a day that already "
        "stands is NOT this tool's — send that to propose_routine_change, which writes nothing and "
        "waits for the lifter's tap. YOU mint `id` and it IS the idempotency key: send the SAME id "
        "with the SAME document to replay a lost reply and the stored routine comes back untouched, "
        "and send it with a DIFFERENT document and you are refused, because that is a change to a "
        "day that already stands and this tool would land it without asking anyone.",
        p, {"id", "name", "position", "entries"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = str("The id YOU mint for this proposal (`prop_` + hex is the house shape).");
    p["routineId"] = routineHandle();
    p["name"] = cappedStr("Rename the routine as part of this change. Omit to keep its name.",
                          kMaxNameLength);
    p["summary"] = cappedStr("One sentence saying what this changes and why — the line the lifter "
                             "reads on the card before they open the diff. Omit it and they read "
                             "the diff alone.",
                             kMaxSummaryLength);
    p["entries"] = entryArray();
    tools.push_back(tool("propose_routine_change", Access::write,
        "Propose a change to a day of the program that already exists. THIS CHANGES NOTHING. It "
        "puts a typed, field-level diff in front of the lifter — `sets 5 × 5 → 5 × 3`, "
        "`weight 82.5 → 87.5`, a line added, a line removed — and their routine keeps reading "
        "exactly as it does now until they open it and tap Apply. Nothing on this connection can "
        "tap it for them: there is no apply tool at any grant level. When you answer your human, "
        "say the routine has not changed and that a proposal is waiting.\n"
        "Send the WHOLE document every time — read it with list_routines, change what you mean, and "
        "send all the entries back, the ones you are not changing included, because a line you leave "
        "out is a line you are proposing to REMOVE. A new proposal replaces whatever you had waiting "
        "on that routine, and the replaced one goes into the routine's history rather than "
        "disappearing. YOU mint `id` and it IS the idempotency key: send the SAME id with the SAME "
        "document to replay a lost reply, never a fresh one, or you supersede your own proposal — "
        "and never that id with a DIFFERENT document, which is refused rather than answered with the "
        "proposal already standing under it.\n"
        "It cannot reach a logged set, a finished workout's frozen plan, or where the day sits in "
        "the week — only what this routine asks for next time.",
        p, {"id", "routineId", "entries"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = str("The id YOU mint for this movement (`ex_` + hex is the house shape).");
    p["name"] = cappedStr("What it is called on screen. Renaming it later keeps every set.", kMaxNameLength);
    p["pattern"] = enumStr("The one classification gym keeps.", kPatterns);
    p["equipment"] = enumStr("What it is loaded with. The one classification gym keeps beside pattern.", kEquipment);
    p["stepKg"] = num("This movement's own increment, stored and served back. NOTHING reads it yet — every logger steps the weight off the load band, not off this. Omit to take the equipment's default.");
    tools.push_back(tool("create_exercise", Access::write,
        "Add a movement the catalog does not hold. Read list_exercises FIRST: a second row for a "
        "movement that already exists forks that lift's history across two ids permanently, and "
        "nothing merges them back.",
        p, {"id", "name", "pattern", "equipment"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["sessionId"] = sessionHandle();
    tools.push_back(tool("share_session", Access::write,
        "Mint a link to ONE workout for a coach. Answers {url, token, expiresAt}: hand over the "
        "URL EXACTLY as given — it opens the workout as a readable page in a browser, and anyone "
        "holding it can read that workout and its sets without signing in. Do not build a link from "
        "the token yourself. It reaches no other workout and names no account, it expires (30 days), and "
        "revoke_share ends it early. Called again while a link is live it answers with that same "
        "link rather than a second one.",
        p, {"sessionId"}));
  }

  {
    Json::Value p(Json::objectValue);
    p["sessionId"] = sessionHandle();
    tools.push_back(tool("discard_session", Access::del,
        "Delete a workout and every set in it. Permanent — nothing keeps a copy and there is no undo. "
        "A workout still running is refused: finish it first, so sets still in flight are not "
        "destroyed under whoever is logging them.",
        p, {"sessionId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = str("The id YOU mint for this proposal (`prop_` + hex is the house shape).");
    p["routineId"] = routineHandle();
    p["summary"] = cappedStr("One sentence saying why this day should go — the line the lifter "
                             "reads on the card.",
                             kMaxSummaryLength);
    tools.push_back(tool("propose_routine_removal", Access::del,
        "Propose taking one whole day out of the program. THIS DELETES NOTHING. It puts that day's "
        "lines in front of the lifter as a diff of what would go, and the routine stays exactly "
        "where it is until they open it and tap Apply — and nothing on this connection can tap it "
        "for them. `gym:delete` buys the right to PROPOSE a destructive change; it does not imply "
        "the right to make one. Every workout ever trained under this routine keeps its frozen copy "
        "whatever the lifter decides, so nothing here can edit what the log says you did. YOU mint "
        "`id` and it IS the idempotency key: the same id names this one proposal for good, so a "
        "resend replays it and a different proposal needs a different id.",
        p, {"id", "routineId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["sessionId"] = sessionHandle();
    tools.push_back(tool("revoke_share", Access::del,
        "End a coach link now. The url stops resolving immediately, and a link that was revoked, has "
        "expired, or never existed are one answer to whoever holds it.",
        p, {"sessionId"}));
  }

  return tools;
}

// The paragraph every client reads at connect, before it has called anything. The retirements are
// named here as well as by GymTools::retiredTools(), so an agent reads them before its first call.
std::string gymInstructions() {
  return "gym is a training log: workouts of sets, a program of routines, and a catalog of "
         "movements. Every write is idempotent by an id YOU mint — send the same id again, carrying the "
         "SAME body, to replay a lost reply; never a fresh id, or you mint a duplicate, and never a "
         "spent id for something you changed your mind about, which is refused. Loads are kg "
         "(negative is legal: "
         "band-assisted work), instants are epoch milliseconds, and only WORKING sets count toward "
         "anything. One workout is open per account at a time. Everything here is one lifter's own "
         "log — these tools read and write that account and reach no other.\n\n"
         "Every read answers with a `read` block — {sets, sessions, weeks} — counted by the server "
         "as it served those rows, and absent when a reply served none. It is the accounting for "
         "THAT reply: say what you read from it rather than estimating how much of a log you have "
         "seen, and never add two of them together, because the same workout read twice is one "
         "workout.\n\n"
         "Writes split in two and the split is the whole contract. Recording something that ALREADY "
         "HAPPENED lands immediately: a set, a workout starting or ending, a movement, a new day of "
         "the program. Changing a day of the program that ALREADY STANDS lands nothing — it mints a "
         "proposal, a typed field-level diff that sits in the lifter's app until they read it and "
         "tap Apply. No tool here applies one, at any grant level, because Apply is theirs and not "
         "yours. So when you propose, tell your human the routine has not changed yet and that "
         "something is waiting for them.\n\n"
         "Retired on 2026-08-12: `save_routine` and `delete_routine` no longer exist at any level. "
         "`create_routine` adds a day that did not exist, `propose_routine_change` proposes a change "
         "to one that does, and `propose_routine_removal` proposes taking one out. If you were "
         "written against the old two, that is why they are missing — they were not un-granted.\n\n"
         "Retired on 2026-08-13 with NO replacement: `get_preferences`. gym keeps no plate inventory "
         "and no bar weight — propose loads in kilograms and let the lifter round at the rack — and "
         "the rest target and reading unit it also carried are their own dials, not context for you "
         "to fetch.";
}

}
