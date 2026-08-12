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

// The tools that CHANGE NOTHING and hand the lifter a typed diff instead. It reads the NAME because
// W6 made the name the contract — `propose_` says this call lands nothing and waits for a tap — and
// a second list of names beside the catalog is the thing that drifts from it. Ask holds every read
// plus exactly these: the safeguard ladder's middle rung (§L), and the whole of what an in-app chat
// is allowed to reach.
//
// A PREFIX IS A GRANT THAT COULD GROW BY NAMING, so it is pinned where it would grow: any future
// `propose_*` tool, at any access level, joins what a model reachable by every account may call
// without one line of AskService changing. That is the intended contract and not an accident — no
// `propose_` tool lands anything — but it must stay a DECISION, so `AskServiceTest` asserts Ask's
// nine offered names literally. Add a tenth and that test fails, which is the conversation.
inline bool mintsProposal(const std::string& toolName) {
  return toolName.rfind("propose_", 0) == 0;
}

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
