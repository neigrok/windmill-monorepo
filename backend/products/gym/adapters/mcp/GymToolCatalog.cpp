#include "products/gym/adapters/mcp/GymToolCatalog.h"

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

// A string with a published cap. The cap exists either way — the domain refuses past it — and a
// client can only pre-validate what the schema states, so it is stated.
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

// Every instant on this surface is epoch milliseconds inside (0, kMaxInstantMs] — the band the
// domain accepts — so a unit-confused caller reads the unit off the schema instead of off a refusal.
Json::Value instant(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "integer";
  property["description"] = description;
  property["minimum"] = 1;
  property["maximum"] = static_cast<Json::Int64>(kMaxInstantMs);
  return property;
}

// The three handles, canonical wherever a tool names something that already exists. Written once so
// two tools cannot describe the same id differently and send an agent looking in two places.
Json::Value sessionHandle() {
  return str("The workout's id — list_sessions answers with it.");
}

Json::Value exerciseHandle() {
  return str("The movement's id — list_exercises answers with it.");
}

Json::Value routineHandle() {
  return str("The routine's id — list_routines answers with it.");
}

// One line of a routine, as save_routine takes it. It is an array of objects and the schema says so
// down to each field: an agent cannot look at an example and recover the way a person reading docs
// can, so what one entry requires is published rather than discovered by a refusal.
Json::Value entryArray() {
  Json::Value fields(Json::objectValue);
  fields["exerciseId"] = exerciseHandle();
  fields["targetSets"] = boundedInt("How many sets this line calls for (1–20).", 1, 20);
  fields["targetReps"] = boundedInt("Reps per set. OMIT to mean `max` — as many as you can.", 1, 500);
  fields["targetWeightKg"] = num("Target load in kg. Omit to mean whatever you did last time.");
  fields["restSeconds"] = boundedInt("Rest between sets. Omit to take the client's default.", 0, 3600);

  Json::Value entry(Json::objectValue);
  entry["type"] = "object";
  entry["properties"] = fields;
  Json::Value required(Json::arrayValue);
  required.append("exerciseId");
  required.append("targetSets");
  entry["required"] = required;

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = entry;
  property["maxItems"] = static_cast<Json::UInt64>(kMaxRoutineEntries);
  property["description"] =
      "The lines of the day, in order — their order IS the routine's order and positions are "
      "assigned 1..n from it. At least one, at most 50.";
  return property;
}

// Each tool names the grant level that reaches it beside the sentence describing what it does, so a
// client cannot be told one thing and gated on another. The three split like this: `read` answers
// questions, `write` adds to the log or the program (and mints a coach link, which creates a
// capability without destroying anything), and `delete` takes away something a lifter LIVED — a
// workout, a day of their program, or a link they handed to a coach. `delete` is never implied by
// `write`: a connection that was not handed that level does not so much as see these three.
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

// Reads, then writes, then deletes — so a narrower grant sees a PREFIX of this list rather than a
// list with holes in it, and two connections at different levels read the same surface in the same
// order. Fifteen tools against roadmap's twenty-seven, and that is on purpose: tools/list is the
// biggest fixed cost of a connection, so a tool that a parameter on another tool could have served
// does not get a slot (routines list and read are one; the finish readout rides on the session read).
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
        "Your training log, newest first — one row per workout: the session plus how many sets it "
        "held, which movements were in it, its heaviest working set, and `closedItself` (the "
        "four-hour rule ended it rather than a tap). Page with BOTH halves of the last row's key, "
        "`before` and `beforeId`, because two workouts can start in the same millisecond.",
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
        "rep target this product can express and a zero could not.",
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
    p["startedAt"] = instant("When the workout began, epoch ms.");
    p["joinOpenSession"] = boolean("Default true: join whatever session is open instead of failing.");
    p["routineId"] = str("The day of the program this is. Omitted, the workout is ad-hoc.");
    tools.push_back(tool("start_session", Access::write,
        "Open a workout. YOU mint `id` and it IS the idempotency key: send the same id again and "
        "the stored workout comes back — never invent a new id to retry, that mints a second "
        "workout. By default this JOINS a session already open (that is how a handoff between "
        "devices works); send `joinOpenSession: false` to mean \"create exactly this one, which is "
        "not now\" — a backfill. A named `routineId` is frozen onto the workout as a copy.",
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
        "Close a workout. The first close is permanent, so a workout already finished (by a tap or "
        "by the four-hour rule) answers with the end it already has rather than being moved.",
        p, {"sessionId", "finishedAt"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = str("The routine's id — an existing one is replaced, a new one YOU mint is created.");
    p["name"] = cappedStr("What this day of the program is called.", kMaxNameLength);
    p["position"] = boundedInt("Where it sits in the program, from 0.", 0, 10000);
    p["entries"] = entryArray();
    tools.push_back(tool("save_routine", Access::write,
        "Create or replace one day of your program. A routine travels as its WHOLE document, every "
        "time — there is no per-line edit — so read it with list_routines, change what you mean, and "
        "send all of it back. Workouts already trained under it keep the copy they froze.",
        p, {"id", "name", "position", "entries"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = str("The id YOU mint for this movement (`ex_` + hex is the house shape).");
    p["name"] = cappedStr("What it is called on screen. Renaming it later keeps every set.", kMaxNameLength);
    p["pattern"] = enumStr("The one classification gym keeps.", kPatterns);
    p["equipment"] = enumStr("What it is loaded with — it decides the default ladder step.", kEquipment);
    p["stepKg"] = num("The ladder increment. Omit to take the equipment's own default.");
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
        "Mint a link to ONE workout for a coach. Answers {url, token, expiresAt}: anyone holding "
        "that url can read that workout and its sets without signing in, so hand it to a person and "
        "not to a page. It reaches no other workout and names no account, it expires (30 days), and "
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
    p["routineId"] = routineHandle();
    tools.push_back(tool("delete_routine", Access::del,
        "Delete one day of your program. Permanent. Every workout ever trained under it keeps its "
        "frozen copy, so deleting the plan never edits what the log says you did.",
        p, {"routineId"}));
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

std::string gymInstructions() {
  return "gym is a training log: workouts of sets, a program of routines, and a catalog of "
         "movements. Every write is idempotent by an id YOU mint — send the same id again to replay "
         "a lost reply, never a fresh one, or you mint a duplicate. Loads are kg (negative is legal: "
         "band-assisted work), instants are epoch milliseconds, and only WORKING sets count toward "
         "anything. One workout is open per account at a time. Everything here is one lifter's own "
         "log — these tools read and write that account and reach no other.";
}

}
