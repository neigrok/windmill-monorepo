#pragma once

#include "platform/ports/ToolHost.h"
#include "products/roadmap/adapters/http/GalleryApi.h"
#include "products/roadmap/adapters/http/SharePageApi.h"
#include "products/roadmap/adapters/http/TreeApi.h"
#include "products/roadmap/adoption/Audit.h"
#include "products/roadmap/adoption/Cutover.h"
#include "products/roadmap/domain/Reminders.h"

#include <functional>
#include <map>
#include <string>
#include <vector>

// The read models' half of the audit (Roadmap on the sync engine §8.1): the same questions asked of the old server's
// read models, over roadmap's rooms and tables, and of the new ones, over the engine's records, each answered by the code
// the route or the tool answers with, and the answers compared.

namespace wm::roadmap::adoption {

// One server's read models: MCP's read tools, the routes of a roadmap's progress and activity, the share page, the
// gallery, and reminders' readiness.
struct ReadModelSide {
  ToolHost& mcp;
  TreeApi& trees;
  SharePageApi& share;
  GalleryApi& gallery;
  std::function<std::vector<TreeReadiness>(const UserId&)> readiness;
};

// For each adopted roadmap, as a stranger: the progress the route answers and what the share page names of it; and as its
// owner: MCP's get_tree with every field and its edges, guides and kinds, every page of it, get_progress, the progress, the activity's
// last lines and the share page. For each owner, list_trees and reminders' readiness; and the gallery once. A roadmap the
// house account owns is asked a stranger's questions alone, its activity among them: nobody signs in as the house. One
// line an answer: the question, its subject, whether the old server reads that subject today, the answer, and an MCP
// answer's seq. An answer that threw is the failure's type alone.
// Four parts of an answer are left out, each a change made by design: an MCP answer's seq, which continues above the old
// one (kept beside the answer, and counted where it did); a step's order key, which the move may give (the documents
// compare the order of the steps; MCP's are kept by id, the engine's tools listing them in their order); a mark's stamp,
// which the move gives where roadmap held none (its time is kept); and what each subtree came to, which the engine's
// progress answer adds.
std::vector<Json::Value> answersOf(ReadModelSide& side, const Survey& survey);

// The new server's answers against the old one's, question by question. A question about a roadmap the old server cannot
// read today (Surveyed::readableToday), or an owner's account-wide question where it holds one, is counted apart: the new
// answer is not held to one the old server never gave.
StageReport compareAnswers(const std::vector<Json::Value>& old, const std::vector<Json::Value>& now, const PrivateRecord& record);
}
