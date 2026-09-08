#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include "products/gym/domain/Bodyweight.h"
#include "products/gym/domain/Note.h"
#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstddef>
#include <algorithm>
#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {

Json::Value str(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "string";
  property["description"] = description;
  return property;
}

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

// Declared so `additionalProperties: false` accepts a document a read emitted. Ignored on input.
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

// Epoch milliseconds inside (0, kMaxInstantMs], the band the domain accepts.
Json::Value instant(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "integer";
  property["description"] = description;
  property["minimum"] = 1;
  property["maximum"] = static_cast<Json::Int64>(kMaxInstantMs);
  return property;
}

Json::Value sessionHandle() {
  return str("The workout's id — list_sessions answers with it.");
}

Json::Value exerciseHandle() {
  return str("The movement's id — list_exercises answers with it.");
}

Json::Value routineHandle() {
  return str("The routine's id — list_routines answers with it.");
}

// Every bound here must match the domain's own (products/gym/domain/Routine.cpp): a wider band here
// invites a value the entity then refuses the whole document over.
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
  // Ignored on the way in; lines are renumbered from their order.
  fields["position"] = boundedInt("Ignored — the order these arrive in IS the order.", 1, 10000);

  Json::Value entry(Json::objectValue);
  entry["type"] = "object";
  entry["properties"] = fields;
  Json::Value required(Json::arrayValue);
  required.append("exerciseId");
  entry["required"] = required;
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

// Each tool names the grant level that reaches it beside its description. `delete` is never implied
// by `write`: a connection without that level does not see those tools at all.
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
  ToolDeclaration declaration{std::move(descriptor), "gym", access};
  // Retry identity follows each tool's caller id, proposal, session end or active share link.
  declaration.idempotent = true;
  return declaration;
}

}  // namespace

// Reads, then writes, then deletes, so a narrower grant sees a prefix of this list rather than one
// with holes in it. No tool at any level edits a logged set, says what a gym owns, or applies a
// proposal.
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
        "own Coach; its `source` says whose. Read it before you propose anything: a new proposal of "
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
    // The bounds are the entity's (domain/Note.h) and the schema's; the sentence states them.
    tools.push_back(tool("list_notes", Access::read,
        "The notes the lifter wrote FOR the agent reading their log — at most ten, each a title of "
        "up to 60 characters and a body of up to 500 bytes, stored exactly as typed. They are the "
        "lifter's own standing instructions to you (how to talk to them, what they are training "
        "for, the programme they run), and the order is precedence: the top note wins where two "
        "disagree. Follow them. A set's `note` is a record of that set and not one of these. "
        "Answers {notes: [{position, title, body}]} and carries no `read` block: a note is not a "
        "log row. Takes no arguments.",
        Json::Value(Json::objectValue), {}));
  }
  {
    // A read and nothing else: no tool at any grant level writes a weigh-in, and nothing named
    // `propose_*` ever will — a weigh-in is a fact only the lifter observed.
    Json::Value p(Json::objectValue);
    p["from"] = str("The first day to include, YYYY-MM-DD, inclusive. Omitted, from the first weigh-in.");
    p["to"] = str("The last day to include, YYYY-MM-DD, inclusive. Omitted, to the last weigh-in.");
    tools.push_back(tool("list_bodyweight", Access::read,
        "The lifter's weigh-ins, one per local calendar day, oldest first: {entries: [{dateLocal, "
        "weightKg}]}. Kilograms, two decimals, and the day is the lifter's own calendar rather than "
        "an instant. Narrow with `from` and `to`. Carries no `read` block: a weigh-in is not a log "
        "row. There is no tool that writes one, at any level, and there never will be — a "
        "bodyweight is a fact only the lifter observed, so an agent writing one would be inventing "
        "a number. Say what the series did and never estimate a weight the entries do not give you.",
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
    p["note"] = cappedStr("A free note on this set, at most 4000 BYTES of UTF-8 — the log counts "
                          "bytes, not characters.", kMaxSetNoteBytes);
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
    // Declared so a document read from list_routines and sent back is not refused; ignored on input.
    p["lastTrainedAt"] = num("Ignored — the log decides when a routine was last trained.");
    p["revision"] = num("Ignored — the store moves a routine's revision; a client reads it, never "
                        "sends it.");
    p["pendingProposal"] =
        ignoredObject("Ignored — a proposal belongs to the routine it was minted against and is "
                      "never carried onto a new one.");
    p["entries"] = entryArray();
    tools.push_back(tool("create_routine", Access::write,
        "Review the user's goals and collect necessary missing constraints before creating training. Add a NEW day to the program. This one LANDS IMMEDIATELY, and that is the rule rather than "
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
        "Mint a link to ONE workout for a person you choose. Answers {url, token, expiresAt}: hand over the "
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
    ToolDeclaration removal = tool("propose_routine_removal", Access::del,
        "Propose taking one whole day out of the program. THIS DELETES NOTHING. It puts that day's "
        "lines in front of the lifter as a diff of what would go, and the routine stays exactly "
        "where it is until they open it and tap Apply — and nothing on this connection can tap it "
        "for them. `gym:delete` buys the right to PROPOSE a destructive change; it does not imply "
        "the right to make one. Every workout ever trained under this routine keeps its frozen copy "
        "whatever the lifter decides, so nothing here can edit what the log says you did. YOU mint "
        "`id` and it IS the idempotency key: the same id names this one proposal for good, so a "
        "resend replays it and a different proposal needs a different id.",
        p, {"id", "routineId"});
    removal.proposal = true;  // the grant is delete-level; the tool mints a card and removes nothing
    tools.push_back(std::move(removal));
  }
  {
    Json::Value p(Json::objectValue);
    p["sessionId"] = sessionHandle();
    tools.push_back(tool("revoke_share", Access::del,
        "End a workout link now. The url stops resolving immediately, and a link that was revoked, has "
        "expired, or never existed are one answer to whoever holds it.",
        p, {"sessionId"}));
  }

  for (const char* name : {"log_sets", "import_session", "get_sessions", "get_last_times"}) {
    const bool write = std::string_view(name) == "log_sets" || std::string_view(name) == "import_session";
    const bool imported = std::string_view(name) == "import_session";
    const bool sessions = std::string_view(name) == "get_sessions";
    Json::Value p(Json::objectValue);
    std::vector<const char*> required;
    if (write) {
      const auto single = std::find_if(tools.begin(), tools.end(), [](const ToolDeclaration& declaration) {
        return declaration.name() == "log_set";
      });
      Json::Value row = single->descriptor["inputSchema"];
      row["properties"].removeMember("sessionId");
      row["properties"]["weightKg"]["description"] = "Load in kg, at most two decimal places.";
      row["properties"]["rpe"]["description"] = "Exertion from 1 to 10, at most one decimal place.";
      row["properties"]["exerciseId"]["minLength"] = 1;
      row["properties"]["exerciseId"]["maxLength"] = 128;
      row["properties"]["id"]["minLength"] = 8;
      row["properties"]["id"]["maxLength"] = 64;
      row["properties"]["id"]["pattern"] = "^[A-Za-z0-9_-]{8,64}$";
      row["properties"]["weightKg"]["minimum"] = -500;
      row["properties"]["weightKg"]["maximum"] = 500;
      row["properties"]["weightKg"]["multipleOf"] = 0.01;
      row["properties"]["rpe"]["minimum"] = 1;
      row["properties"]["rpe"]["maximum"] = 10;
      row["properties"]["rpe"]["multipleOf"] = 0.1;
      row["required"] = Json::Value(Json::arrayValue);
      for (const char* field : {"id", "exerciseId", "weightKg", "reps", "completedAt"}) row["required"].append(field);
      p["sets"]["type"] = "array";
      p["sets"]["items"] = row;
      p["sets"]["minItems"] = imported ? 0 : 1;
      p["sets"]["maxItems"] = static_cast<Json::UInt64>(kMaxSetBatch);
      p["sets"]["description"] = "Ordered performed sets with distinct ids. Validate all rows before one transaction; never use a new id to retry.";
      if (imported) {
        p["id"] = str("Caller-minted id of the completed historical workout.");
        p["startedAt"] = instant("When this workout actually started.");
        p["finishedAt"] = instant("When it ended, at or after startedAt and no later than now.");
        p["routineId"] = routineHandle();
        required = {"id", "startedAt", "finishedAt", "sets"};
      } else {
        p["sessionId"] = sessionHandle();
        required = {"sessionId", "sets"};
      }
      const char* sessionField = imported ? "id" : "sessionId";
      p[sessionField]["minLength"] = 8;
      p[sessionField]["maxLength"] = 64;
      p[sessionField]["pattern"] = "^[A-Za-z0-9_-]{8,64}$";
    } else {
      const char* field = sessions ? "sessionIds" : "exerciseIds";
      p[field]["type"] = "array";
      p[field]["items"] = cappedStr("Exact id.", 128);
      p[field]["minItems"] = 1;
      p[field]["maxItems"] = static_cast<Json::UInt64>(kMaxBatchReadIds);
      p[field]["uniqueItems"] = true;
      p[field]["description"] = "1..50 exact ids; results preserve this order and identify missing ids explicitly.";
      if (sessions) p["review"] = boolean("Include each workout's review; defaults to false.");
      required = {field};
    }
    const char* description =
        imported ? "Import one already-completed workout and up to 200 performed sets in one transaction. "
                   "All set times must fall inside its interval, with no future facts. Leaves the live workout alone. "
                   "An exact id/body retry returns current status without duplicating or restoring corrected/deleted data; a changed request conflicts."
        : write ? "Log 1..200 ordered performed sets into one workout atomically. Every item is validated; one bad row commits nothing. "
                  "Exact id/body retries return current status, including deleted rows, without changing them. Reusing an id with different data conflicts. "
                  "Times must be at or after workout start and no later than now. Use import_session for an already-completed workout."
        : sessions ? "Read 1..50 exact workouts with their sets, in requested order, plus missingSessionIds. Optionally include review. "
                     "The complete tools/call result is limited to 262144 serialized bytes; request fewer ids or omit review if refused."
        : "Read the last completed workout for 1..50 exact exercise ids in requested order. trained:false means no completed non-warmup set history; "
          "missingExerciseIds names exercises outside the available catalog. The complete result is limited to 262144 serialized bytes; retry with fewer ids if refused.";
    ToolDeclaration declaration = tool(name, write ? Access::write : Access::read, description, p, required);
    Json::Value output(Json::objectValue);
    output["type"] = "object";
    output["additionalProperties"] = false;
    output["required"] = Json::Value(Json::arrayValue);
    Json::Value& properties = output["properties"];
    if (write) {
      properties["sessionId"] = sessionHandle();
      properties["applied"] = boolean("True for an accepted batch or an exact replay.");
      properties["replayed"] = boolean("True when all requested facts were accepted earlier.");
      properties["sessionDeleted"] = boolean("True if an imported workout was later deleted; it is never restored by a retry.");
      if (imported) properties["imported"] = boolean("Whether the imported workout currently exists.");
      properties["sets"]["type"] = "array";
      properties["sets"]["items"]["type"] = "object";
      properties["sets"]["items"]["additionalProperties"] = false;
      properties["sets"]["items"]["properties"]["id"] = str("Requested set id.");
      properties["sets"]["items"]["properties"]["status"] = enumStr("Current result for this id.", {"created", "replayed", "deleted"});
      properties["sets"]["items"]["properties"]["setNumber"]["type"] = "integer";
      properties["sets"]["items"]["required"] = Json::Value(Json::arrayValue);
      properties["sets"]["items"]["required"].append("id");
      properties["sets"]["items"]["required"].append("status");
      for (const char* field : {"sessionId", "applied", "replayed", "sessionDeleted", "sets"}) output["required"].append(field);
      if (imported) output["required"].append("imported");
    } else {
      const char* rows = sessions ? "sessions" : "exercises";
      const char* missing = sessions ? "missingSessionIds" : "missingExerciseIds";
      properties[rows]["type"] = "array";
      properties[rows]["items"]["type"] = "object";
      properties[missing]["type"] = "array";
      properties[missing]["items"]["type"] = "string";
      properties["read"]["type"] = "object";
      output["required"].append(rows);
      output["required"].append(missing);
    }
    declaration.descriptor["outputSchema"] = output;
    tools.push_back(std::move(declaration));
  }

  std::stable_sort(tools.begin(), tools.end(), [](const ToolDeclaration& left, const ToolDeclaration& right) {
    return left.access < right.access;
  });
  return tools;
}

std::string gymInstructions() {
  return "Coach in a friendly, informal voice. Before recommending a training change, revisit the "
         "user's goals and current constraints. Use their earlier answers and training history, and "
         "ask only for missing information that could materially change the plan. Do not propose or "
         "make training changes until the human has supplied that necessary information; explain what "
         "each missing fact affects without inventing an answer. Make changes systematically: connect "
         "each adjustment to the goal and check exercises, schedule, volume, progression and stated "
         "constraints together. Respect the user's reported limits. "
         "Keep changes to existing routines in the proposal flow and leave Apply to the user. "
         "This intake guides training decisions; record supplied workout facts without requiring coach intake.\n\n"
         "gym is a training log: workouts of sets, a program of routines, and a catalog of "
         "movements. For tools with caller-minted ids, retry lost replies using the SAME id and body; "
         "new ids may create duplicates. Follow each tool's specific replay contract. Loads are kg "
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
         "HAPPENED lands immediately: a set or a workout starting or ending. Creating a routine also "
         "lands immediately, but is a training decision that requires the necessary goals and constraints. "
         "Changing a day of the program that ALREADY STANDS lands nothing — it mints a "
         "proposal, a typed field-level diff that sits in the lifter's app until they read it and "
         "tap Apply. No tool here applies one, at any grant level, because Apply is theirs and not "
         "yours. So when you propose, tell your human the routine has not changed yet and that "
         "something is waiting for them.\n\n"
         "`save_routine` and `delete_routine` do not exist at any level. `create_routine` adds a day "
         "that did not exist, `propose_routine_change` proposes a change to one that does, and "
         "`propose_routine_removal` proposes taking one out. If you were written against the old "
         "two, that is why they are missing — they were not un-granted.\n\n"
         "`get_preferences` does not exist and nothing replaced it. gym keeps no plate inventory "
         "and no bar weight — propose loads in kilograms and let the lifter round at the rack — and "
         "the rest target and reading unit it also carried are their own dials, not context for you "
         "to fetch.\n\n"
         "Bodyweight is read-only here: `list_bodyweight` answers the lifter's weigh-ins, and no "
         "tool at any level writes one, because a weigh-in is a fact only the lifter observed.";
}

}
