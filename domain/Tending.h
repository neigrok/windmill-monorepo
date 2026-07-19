#pragma once

#include "domain/Ids.h"

#include <cstdint>
#include <string>

namespace wm {

// One sentence someone told their tree, and what became of it.
//
// A tend run is a JOB, not a stream. The browser starts one and is free to leave — lock the
// phone, take a call, switch apps — and the run carries on without it. That is the whole shape
// of this feature, because the moment it exists for is a mobile one, and a mobile browser
// suspends a backgrounded tab: frozen timers, a dropped socket, an aborted request. Anything
// that lived in the page would die there.
//
// So nothing about a run depends on the client staying connected:
//   - the agent's edits land through the tree's room and into the op log exactly as a person's
//     do, so a client that reconnects and resubscribes receives them as an ordinary delta and
//     never needs to know an agent was the author
//   - the run's own state lives in Postgres, so it outlives the socket, the tab and the process
//   - the worst an absence can cost is the ANIMATION. You come back to a finished tree and a
//     receipt waiting — never to half a tree, and never to a run that quietly died with the tab.
enum class TendStatus {
  running,   // the loop is working; edits may already be landing
  done,      // finished cleanly, `summary` is the receipt
  failed,    // upstream error, timeout, or a tool that would not settle
  refused,   // never started: not enabled, rate limited, or over allowance
};

inline const char* tendStatusName(TendStatus status) {
  switch (status) {
    case TendStatus::running: return "running";
    case TendStatus::done:    return "done";
    case TendStatus::failed:  return "failed";
    case TendStatus::refused: return "refused";
  }
  return "failed";
}

// Why a run never started. The client turns these into the spec's four quiet faces; `none` is
// the ordinary case where the run did start.
enum class TendRefusal { none, notEnabled, rateLimited, outOfAllowance, treeTooLarge, promptEmpty };

inline const char* tendRefusalName(TendRefusal refusal) {
  switch (refusal) {
    case TendRefusal::none:           return "";
    case TendRefusal::notEnabled:     return "not-enabled";
    case TendRefusal::rateLimited:    return "rate-limited";
    case TendRefusal::outOfAllowance: return "out-of-allowance";
    case TendRefusal::treeTooLarge:   return "tree-too-large";
    case TendRefusal::promptEmpty:    return "prompt-empty";
  }
  return "";
}

struct TendRun {
  std::string id;
  TreeId tree;
  UserId user;
  std::string prompt;
  TendStatus status = TendStatus::running;
  TendRefusal refusal = TendRefusal::none;
  std::string summary;   // the receipt line: "Added 3 steps under Backend"
  std::string detail;    // the "why", shown only when the receipt is tapped
  int edits = 0;         // tool calls that changed something — 0 means the tree is untouched
  // The run's footprint in the tree's op log: every op it wrote falls in (seqFrom, seqTo].
  // This is what makes one sentence one undo — including for a client that was asleep for all
  // of it, which is precisely when the user most needs the way back.
  std::uint64_t seqFrom = 0;
  std::uint64_t seqTo = 0;
  std::uint64_t startedAtMs = 0;
  std::uint64_t finishedAtMs = 0;
};

// The prompt cap. Long enough for someone to describe a goal properly, short enough that the
// field is a sentence rather than a document — pasting a document is what paste-import is for.
constexpr std::size_t kMaxTendPromptBytes = 2000;

}
