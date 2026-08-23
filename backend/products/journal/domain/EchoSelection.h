#pragma once

#include "products/journal/domain/Page.h"

#include <cstdint>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// A passage as retrieval sees it: who it is, when it was written, what it says, where it sits in
// the embedding space.
struct Vectored {
  std::int64_t spanId = 0;
  LocalDate day;
  std::string text;
  std::vector<float> vector;
};

// Every knob in one struct so a test can vary one and a reader can see the whole policy at once.
// The defaults are the shipped policy; nothing else in the codebase may hardcode these numbers.
struct SelectionRules {
  int minDayGap = 7;              // a page younger than a week is not an echo
  int shown = 10;                 // the cap on ONE TRIGGER's pairings — not the page's. A page with
                                  // eight triggering passages is capped by SweepBudget::echoesPerPage,
                                  // which is the only place a whole page is in view.

  double refrainRadius = 0.80;    // a candidate this close counts toward the crowd
  int refrainCrowd = 5;           // this many neighbours and the trigger is a refrain, not a thought

  double familyRadius = 0.85;     // candidates this close to EACH OTHER collapse into one family
  double restatement = 0.97;      // a candidate this close to the trigger is a restatement, not a memory

  int perBand = 8;                // top-k retrieved from each age band
  int maxRecent = 2;              // at most this many shown from the last 30 days
  int maxPerMonth = 2;            // at most this many shown from any one calendar month

  double distanceWeight = 0.15;   // alpha — the card sells distance, so distance must rank
  double familyPenalty = 0.25;    // beta  — a candidate standing for 30 near-copies is worth less
  double diversityPenalty = 0.50; // gamma — punish similarity to what is already selected
};

// One trigger-to-candidate pairing that survived selection, ready for curation.
struct Pairing {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
  float cosine = 0.0f;
  float score = 0.0f;         // the ranked score; ordering is by this, descending
  int familySize = 1;         // how many near-identical candidates this one stands for
};

// Cosine in [0, 1]. Mismatched or zero-norm vectors resonate with nothing — 0, never a divide.
float cosine(const std::vector<float>& a, const std::vector<float>& b);

// Whole days from `earlier` to `later`, negative if the order is reversed. Pure integer civil-date
// arithmetic (days-from-civil) so a developer's mac and CI's linux cannot disagree.
long daysBetween(const LocalDate& earlier, const LocalDate& later);

// Do these two passages share at least one low-frequency lexical anchor — a name, a rare content
// word, something outside the common-word list?
//
// This is the enforcement mechanism for "an echo may only assert something the user can CHECK from
// what is on screen". The case it exists for is two passages that reach near-identical cosine
// through DIFFERENT words, about different subjects — maximum apparent evidence, and no way at all
// for the reader to tell whether the pairing is right. Requiring one shared uncommon word means
// they can always see why two passages were put together. No anchor, no echo, whatever the cosine
// says.
//
// (Two verbatim copies of a pronoun-only line do share words, so they pass — the rule bites on
// different-words collisions, which is the real failure and the stronger claim.)
bool sharesAnchor(const std::string& a, const std::string& b);

// How many passages sit within `refrainRadius` of this trigger, its own row excluded. The count
// behind `isRefrain`, exposed because the debug door has to show the number the rule read rather
// than a second count of its own that could disagree with it.
int crowdOf(const Vectored& trigger, const std::vector<Vectored>& corpus,
            const SelectionRules& rules);

// Is this trigger a refrain ("tired again", "long day, nothing to report") rather than a thought?
// Measured on a real single-author corpus: a refrain has twenty-plus neighbours above
// `refrainRadius`; every genuine echo trigger has between zero and six. A refrain emits nothing —
// it is the rule that stops a nightly journal handing someone ten copies of last Tuesday.
bool isRefrain(const Vectored& trigger, const std::vector<Vectored>& corpus,
               const SelectionRules& rules);

// The corpus narrowed to what this trigger is judged against: at least `minDayGap` older, then
// top-`perBand` by cosine from EACH age band — 7-30d, 1-3mo, 3-12mo, 1-3y, 3y+.
//
// Banding rather than a flat top-N is what makes the feature's own thesis reachable. "You may have
// forgotten you ever planned it" is a function of age, so an old passage has to compete against its
// own era; against a flat top-30 on a dense journal it loses every time to structurally similar
// prose from last month, and the curator can only reject — it can never rescue what retrieval
// never surfaced.
std::vector<Vectored> stratify(const Vectored& trigger, const std::vector<Vectored>& corpus,
                               const SelectionRules& rules);

// Collapse near-identical candidates into families (keeping the OLDEST member, which is the one the
// product's own copy is about), drop restatements, apply the recency and per-month quotas, score,
// and return at most `shown` pairings ordered by score. The oldest qualifying candidate is
// guaranteed a slot: the first time someone wrote a thing is the payload, and nothing else in the
// ranking protects it.
//
// Deterministic — the same inputs always yield the same pairings in the same order.
std::vector<Pairing> select(const Vectored& trigger, const std::vector<Vectored>& candidates,
                            const SelectionRules& rules);

// WHAT BECAME OF ONE CANDIDATE, in the order the rules run. The debug door reads these, and they
// are produced BY the selection itself rather than by a second pass that re-decides the same
// questions — a reason that can disagree with the behaviour it describes is worse than no reason.
enum class Fate {
  selected,
  notRetrieved,    // close enough to be worth reporting, but retrieval never handed it over:
                   // younger than minDayGap, or beaten inside its own age band
  restatement,     // cosine >= rules.restatement — the same sentence again, not a memory
  noAnchor,        // no low-frequency word in common, so the reader could not check the pairing
  familyMember,    // collapsed into a near-identical family; `representative` is the one that stood
  recencyQuota,    // the last 30 days were already full
  monthQuota,      // its calendar month was already full
  outranked,       // qualified, lost the ranking
  dismissed,       // the reader waved this pairing away
  pageCap,         // selected for its trigger, then cut by the page's own ceiling
};

const char* fateText(Fate fate);

// One candidate as the selection saw it. Every number the ranking read, so a knob can be moved
// against real passages instead of against a guess.
struct CandidateNote {
  std::int64_t spanId = 0;
  LocalDate day;
  std::string text;
  float cosine = 0.0f;
  long ageDays = 0;
  double z = 0.0;                    // against this trigger's own retrieved background
  double score = 0.0;                // the ranked score, where the candidate got as far as ranking
  int familySize = 1;
  std::int64_t representative = 0;   // the family's oldest member; its own id when it stood itself
  Fate fate = Fate::outranked;
};

// One trigger passage's whole pass: the refrain count, what retrieval handed over, the background
// the z-scores are against, and every candidate's fate.
struct TriggerTrace {
  std::int64_t spanId = 0;
  std::string text;
  int crowd = 0;
  bool refrain = false;
  int history = 0;                        // passages the corpus offered, before any gate
  int retrieved = 0;                      // what stratify handed to selection
  double mean = 0.0;
  double stddev = 0.0;
  std::vector<CandidateNote> notes;
};

// One trigger's selection, with the reasons. `select` is this without them.
struct Selection {
  std::vector<Pairing> pairings;
  std::vector<CandidateNote> notes;
  double mean = 0.0;
  double stddev = 0.0;
};

Selection selectExplained(const Vectored& trigger, const std::vector<Vectored>& candidates,
                          const SelectionRules& rules);

// A WHOLE PAGE's pairings — the refrain gate, per-trigger selection, the reader's dismissals and
// the page ceiling, in that order. It lives here rather than in the sweep because it is the last
// step that is a pure function of passages and rules, and because the debug door has to be able to
// run exactly what a save runs.
//
// `nearestReported` buys the near misses: the N closest passages retrieval did NOT hand over,
// noted as `notRetrieved`. It costs one extra cosine pass over the corpus per trigger, which is the
// dominant cost of a derivation, so the live path asks for none and only the debug door pays.
struct PageSelection {
  std::vector<Pairing> pairings;   // after the page cap, best first
  std::vector<TriggerTrace> traces;
  int refrains = 0;                // trigger passages that emitted nothing
  int cappedOut = 0;               // pairings the page ceiling cut
};

PageSelection selectForPage(const std::vector<Vectored>& tonight,
                            const std::vector<Vectored>& history,
                            const std::set<std::pair<std::int64_t, std::int64_t>>& dismissed,
                            const SelectionRules& rules, int echoesPerPage,
                            int nearestReported = 0);

}
