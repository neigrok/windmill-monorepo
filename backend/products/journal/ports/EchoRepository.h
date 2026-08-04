#pragma once

#include "platform/domain/Auth.h"
#include "products/journal/domain/EchoSelection.h"
#include "products/journal/domain/SpanReconcile.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// A candidate user for a nightly pass: someone with recent page activity. The email rode along
// when the sweep asked billing whether to derive at all; the entitlement gate moved to the read
// layer and NOTHING reads this field today. It stays only because dropping it is a port change
// that buys nothing yet — if a second pass over this port is due, drop it then.
struct EchoUser {
  UserId user;
  Email email;
};

// A page owed a derivation — its body moved past what was last derived from it, or the corpus
// around it did. `source` rides along because spoken pages have no reliable sentence boundaries and
// have to segment differently. `attempts` is how many passes in a row have failed on this page: it
// is here so the sweep can back off one the vendor keeps refusing rather than billing for it every
// night, and nothing backs off on it yet.
struct DuePage {
  LocalDate day;
  std::string body;
  Source source = Source::typed;
  std::uint64_t bodyStampMs = 0;
  int attempts = 0;
};

// A passage on its way to storage. `spanId` of 0 means reconcile found no survivor for this text
// and storage mints a fresh identity; anything else is an identity the caller decided to carry
// forward, and storage only records that decision. `passage` is exactly what segmentation
// produced, so [lo, hi) still indexes the body it came from.
struct SpanWrite {
  std::int64_t spanId = 0;
  Passage passage;
  std::vector<float> vector;
};

// Two passages named the way the pipeline holds them. Used for the pairs a reader has waved away —
// the storage side resolves those through content hashes, so the sweep never has to know that
// dismissal is keyed on anything but the spans in front of it.
struct SpanPair {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
};

// One kept pair on its way to storage.
struct EchoRow {
  std::int64_t triggerSpanId = 0;
  LocalDate matchDay;
  std::int64_t matchSpanId = 0;
  float cosine = 0.0f;
  float relation = 0.0f;
  bool matchIsSelf = true;
};

// One page's curation as it lands. The version and the prompt hash ride the whole call because one
// curate call produced every row in it.
struct CuratedEchoes {
  std::string curatorVersion;
  std::string promptHash;
  std::vector<EchoRow> rows;
};

// How the last pass over a page ended. `emptyOk` is a page that genuinely had nothing to reach
// back to — done, not owed a retry; everything after it is a FAILURE, and a failure must never be
// stored as an empty result, which would lose the page to a transient blip at 02:14.
enum class CurationStatus { ok, emptyOk, transport, rateLimited, truncated, schemaInvalid, refused };

inline bool isSuccess(CurationStatus status) {
  return status == CurationStatus::ok || status == CurationStatus::emptyOk;
}

// What the pass derived from, and how it went. The two stamps are the page's "I am done" record,
// and storage advances them only on success — the one rule that keeps a failed night from costing
// a page its echoes permanently.
struct CurationOutcome {
  CurationStatus status = CurationStatus::ok;
  std::uint64_t bodyStampMs = 0;
  std::uint64_t corpusStamp = 0;
  std::string error;
};

// One echo as the reader's page receives it. Both passages travel as TEXT: the client re-locates
// the quote in the live body and shows it only if it is still there, so a redaction propagates
// without a delete ever having to reach the browser. `daysEarlier` is measured from the trigger
// day, never from today: "212 days earlier" is true on every page, "212 days ago" is true only on
// tonight's.
//
// `matchOccurrenceHint` is WHICH occurrence of `matchText` the passage is — 0 for the first in the
// match page's body, 1 for the second — and it is the only thing that keeps a page saying "i don't
// know." twice from anchoring the quote to the wrong one. It is deliberately not the byte offset
// storage holds: C++ counts bytes and JavaScript slices UTF-16 code units, so [lo, hi) parts
// company with anything a browser can use at the first non-ASCII character, and a codepoint offset
// parts company again at the first emoji. An occurrence index has no encoding in it to disagree
// about. It stays a HINT and nothing more: -1 says the server has nothing honest to offer, and the
// text check — not this number — is what decides whether the quote is still there.
struct EchoView {
  LocalDate triggerDay;
  std::int64_t triggerSpanId = 0;
  std::string triggerText;
  LocalDate matchDay;
  std::int64_t matchSpanId = 0;
  std::string matchText;
  bool matchIsSelf = true;
  Source matchSource = Source::typed;
  int daysEarlier = 0;
  int matchOccurrenceHint = -1;
};

// Which occurrence of `text` the passage sitting at byte offset `lo` is, counted the way a browser
// counts: scan from the start, step past each hit, stop at the one that begins where the passage
// does. -1 when no hit begins there — the body has moved under the passage since it was derived,
// and a number that names the wrong sentence is worse than no number at all.
//
// Server-side and client-side scans agree because neither is told about encoding: the search is
// over whole occurrences of the same string, so bytes here and UTF-16 code units there land on the
// same one.
inline int occurrenceAt(const std::string& body, const std::string& text, int lo) {
  if (text.empty() || lo < 0) return -1;
  int occurrence = 0;
  for (std::size_t at = body.find(text); at != std::string::npos;
       at = body.find(text, at + text.size())) {
    if (static_cast<int>(at) == lo) return occurrence;
    if (static_cast<int>(at) > lo) return -1;
    ++occurrence;
  }
  return -1;
}

// Storage for the echo pipeline. Owner-scoped throughout. Entitlement is NOT asked here, and it is
// not asked by the sweep either: the sweep derives for everyone and the READ layer decides how much
// of a passage a reader is handed. The canon's honest-cut state has to show a non-subscriber that
// echoes exist, how many and how far back, none of which survives an empty table.
//
// The seven steps of ECHOES.md read across this port in order: activeSince and duePages open a
// pass, spansOf and replaceSpans carry passage identity across a re-derivation, corpusOf feeds
// retrieval, dismissalsOn removes what the reader waved away, replaceEchoes and recordCuration
// close a page, and inboundPages is the reverse edge that keeps an edited page from silently
// killing every echo aimed at it. The last three serve the reader rather than the pass.
struct EchoRepository {
  virtual ~EchoRepository() = default;

  virtual std::vector<EchoUser> activeSince(std::uint64_t sinceMs) = 0;

  // The newest passage stamp anywhere in this user's corpus. Read ONCE at the top of a pass and
  // carried through it: a page derived halfway through would otherwise record a stamp covering
  // spans it never saw, and would never re-run against them.
  virtual std::uint64_t corpusStamp(const UserId& user) = 0;
  virtual std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp) = 0;

  // Ordered by ord — reconcile matches duplicated text within a page in document order, so the
  // order this returns in is part of the contract, not a convenience.
  virtual std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) = 0;
  virtual void replaceSpans(const UserId& user, const LocalDate& day,
                            const std::vector<SpanWrite>& spans, const std::string& embedVersion,
                            std::uint64_t bodyStampMs) = 0;

  // Every passage the user has, without a single page body attached — the corpus load is the whole
  // cost of a night and a body is dead weight in it. One embedding version only: cosine across two
  // spaces is not degraded, it is meaningless, and nothing about it looks like an error.
  virtual std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) = 0;

  virtual std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) = 0;
  virtual void dismiss(const UserId& user, std::int64_t triggerSpanId,
                       std::int64_t matchSpanId) = 0;

  // "Not useful" is panel-level on the surface — one tap retires the whole page — so it is one
  // call here. Nine calls for nine matches is nine chances to half-succeed, and a page left half
  // faded is a page that comes back tomorrow still carrying the thing the reader waved away.
  virtual void dismissPage(const UserId& user, const LocalDate& triggerDay) = 0;

  virtual void replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                             const CuratedEchoes& curated) = 0;
  virtual void recordCuration(const UserId& user, const LocalDate& day,
                              const CurationOutcome& outcome) = 0;

  // The trigger days holding an echo into this page. Budget the walk: a three-hundred-page cleanup
  // pass has to drain over several nights rather than bill in one.
  virtual std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& matchDay) = 0;

  virtual std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                          const LocalDate& to) = 0;

  // How many pages the user has actually written on. The surface owes the reader nothing below a
  // ~20-page corpus floor — no mark and no offer — and a journal with nothing to reach back into
  // must not advertise reaching back. Only the server can count that, so only the server may say it.
  virtual int pagesWritten(const UserId& user) = 0;
};

}
