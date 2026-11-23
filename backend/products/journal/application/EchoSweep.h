#pragma once

#include "platform/ports/Clock.h"
#include "products/journal/domain/EchoSelection.h"
#include "products/journal/ports/Curator.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/Embedder.h"
#include "products/journal/ports/Segmenter.h"

#include "platform/application/Heartbeat.h"

#include <cstdint>
#include <functional>
#include <string>
#include <string_view>

namespace wm {

struct EchoSweepReport {
  int usersScanned = 0;
  int pagesDerived = 0;
  // TRIGGERS, not pages: one page can carry several, and the old name said the wrong noun in the
  // one place an operator reads to find out why a night was quiet.
  int triggersSkippedRefrain = 0;
  int passagesEmbedded = 0;
  int echoesWritten = 0;
  int pagesFailed = 0;
  int pagesDeferred = 0;
  // Boundary indices a segmenter named that could not be used — out of range, out of order, or the
  // same atom opened twice. It counts confusion rather than invention: since the model answers with
  // atom numbers instead of text, it cannot misquote anyone. Above zero on an ordinary night means
  // it is answering about a page it did not read properly.
  int unitsDiscarded = 0;
  // Pages the vendor declined to judge; unlike `pagesFailed`, they are never owed again.
  int pagesRefused = 0;
  int inboundEnqueued = 0;
  int pagesOverBudget = 0;
  // Accounts whose part of the pass ended at the AI service's refusal of the account's own budget, slot or rate; their
  // pages not yet asked stay due.
  int accountsStopped = 0;
  // The word that ended the whole pass early — the AI service's refusal for itself, no answer from it, or a refusal of
  // the backend's pass — or empty for a pass that ran to its end. The pages not yet asked stay due.
  std::string passStoppedBy;
};

// How much of a pass the end of one page stops (echoes-on-ai-service.md §4): nothing past the page; the rest of its
// account's pages, when the AI service refused the account's own budget, slot or rate; or the whole pass, when the
// service refused for itself, gave no answer, refused the backend's pass or answered as no background call should.
enum class EchoHalt { page, account, pass };

// What one night is allowed to cost a single user.
struct SweepBudget {
  int pagesPerUser = 40;
  int inboundPerPage = 20;

  // The page-level cap; `SelectionRules::shown` bounds one trigger's pairings.
  int echoesPerPage = 10;
};

//   segment -> embed -> reconcile -> retrieve -> select -> curate -> persist
//
// Runs on its own trantor thread, never a request loop. Segmenting is a vendor call, asked only when
// the page's body moved; a corpus that moved under unchanged text reads its units back out of
// storage. Derivation stamps advance only when the pass settled, and a refusal settles the page
// though it failed, so only an edit to the body reopens it. A call the AI service defers leaves the
// page due with no attempt counted (echoes-on-ai-service.md §5).
class EchoSweep {
public:
  EchoSweep(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
            Clock& clock, SelectionRules rules, SweepBudget budget);

  void start();
  void stop() { heartbeat_.stop(); }

  // `sinceMs` decides which users to scan and nothing else; the rest is decided by corpus stamps.
  // `rejudgeAll` takes every page of every scanned writer rather than the ones the stamps say are
  // owed, and re-cuts nothing, so it costs the embedder and curator but never the segmenter.
  EchoSweepReport run(std::uint64_t sinceMs, bool rejudgeAll = false);

  // The same pass, queued onto this sweep's own loop.
  void runAsync(std::uint64_t sinceMs, std::function<void(EchoSweepReport)> done,
                bool rejudgeAll = false);

  // One page, because its writer just saved it. Does not walk the reverse edge.
  EchoSweepReport derivePage(const UserId& user, const LocalDate& day);

private:
  // A page's end: what storage records, the word the step that ended it failed with, how much of the pass that stops,
  // and the static name Sentry is told it under — empty for an end the pass expects.
  struct Derivation {
    CurationOutcome outcome;
    std::string failure;
    EchoHalt halt = EchoHalt::page;
    std::string_view toldAs;
  };

  // The caller owns the report counters.
  Derivation derive(const UserId& user, const DuePage& page, std::uint64_t corpusStamp, EchoSweepReport& report);

  Derivation settlePage(const UserId& user, const DuePage& page, std::uint64_t corpusStamp, EchoSweepReport& report);
  PipelineVersions versions() const;

  EchoRepository& echoes_;
  Segmenter& segmenter_;
  Embedder& embedder_;
  Curator& curator_;
  Clock& clock_;
  SelectionRules rules_;
  SweepBudget budget_;
  Heartbeat heartbeat_;   // declared last: destructs first, before the deps a running pass holds
};

}
