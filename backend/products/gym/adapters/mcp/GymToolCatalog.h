#pragma once

#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm::gym {

// The three published vocabularies, shared by the schemas that advertise them and the domain that
// refuses against them (parsePattern / parseEquipment / parseSetKind, domain/Training.h). A legal
// set an agent can read off `tools/list` costs one round trip less than one it discovers by being
// refused. GymToolsTest round-trips every word here through the domain, so a word added there and
// forgotten here fails a test rather than quietly narrowing what an agent believes it may send.
inline const std::vector<const char*> kPatterns = {"squat", "hinge", "press",
                                                   "pull",  "carry", "core", "isolation"};
inline const std::vector<const char*> kEquipment = {"barbell", "dumbbell",   "machine",
                                                    "cable",   "bodyweight", "kettlebell"};
inline const std::vector<const char*> kSetKinds = {"warmup", "working", "drop", "failure"};

// What a page of the log costs an agent. The REST reader is a screen and takes 50; a tool reply is
// context, and an agent that wants more says so — the same MCP-only leanness roadmap's read
// projections take, at the one gym read that can return an unbounded number of rows.
constexpr int kDefaultLogLimit = 20;
constexpr int kMaxLogLimit = 200;

// What gym advertises to an agent: every tool, its sentence, the JSON Schema its arguments are
// pre-validated against, and the grant level that reaches it. It is the whole published contract and
// nothing else — no service, no caller — so what an agent is promised reads in one file, apart from
// the dispatch that keeps the promise (GymTools.cpp).
std::vector<ToolDeclaration> gymToolCatalog();

// Gym's paragraph in the `initialize` brief, and only the paragraph: the server's name and the
// sentence about what a short tools/list means belong to windmillServerInfo, which speaks for every
// connected product. This one carries the vocabulary an agent needs before its first call.
std::string gymInstructions();

}
