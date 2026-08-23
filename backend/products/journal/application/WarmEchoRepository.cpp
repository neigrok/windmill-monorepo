#include "products/journal/application/WarmEchoRepository.h"

#include <utility>

namespace wm {

WarmEchoRepository::WarmEchoRepository(EchoRepository& storage, Clock& clock, std::uint64_t ttlMs)
    : storage_(storage), clock_(clock), ttlMs_(ttlMs) {}

std::vector<Vectored> WarmEchoRepository::corpusOf(const UserId& user,
                                                   const std::string& embedVersion) {
  const std::uint64_t nowMs = clock_.nowMs();
  std::uint64_t writesBefore = 0;
  {
    std::lock_guard<std::mutex> guard{lock_};
    writesBefore = writes_[user.str()];
    auto held = warm_.find(user.str());
    // The version check matters most: cosine across two embedding spaces is meaningless, and
    // nothing about it looks like an error.
    if (held != warm_.end() && held->second.embedVersion == embedVersion &&
        nowMs - held->second.loadedAtMs < ttlMs_) {
      std::vector<Vectored> corpus;
      for (const auto& [day, passages] : held->second.byDay)
        corpus.insert(corpus.end(), passages.begin(), passages.end());
      return corpus;
    }
  }

  // Loaded outside the lock: holding a mutex across the multi-megabyte call would hand every other
  // user the cost this class exists to spare.
  std::vector<Vectored> corpus = storage_.corpusOf(user, embedVersion);

  Warm fresh;
  fresh.embedVersion = embedVersion;
  fresh.loadedAtMs = nowMs;
  for (const Vectored& span : corpus) fresh.byDay[span.day.iso()].push_back(span);

  std::lock_guard<std::mutex> guard{lock_};
  ++loads_;

  // Expired entries are DROPPED here, not merely ignored: the TTL check on the read path decides
  // only whether a copy may be USED, so without this loop every user who ever derived in this
  // process holds their corpus until it exits.
  for (auto it = warm_.begin(); it != warm_.end();) {
    if (it->first != user.str() && nowMs - it->second.loadedAtMs >= ttlMs_) it = warm_.erase(it);
    else ++it;
  }

  // A write that landed while the load was in flight makes what came back already old, and storing
  // it would keep it old for the whole TTL. The answer still goes to this caller, which asked
  // before the write; it is simply not kept.
  if (writes_[user.str()] != writesBefore) return corpus;
  warm_[user.str()] = std::move(fresh);
  return corpus;
}

std::vector<Vectored> WarmEchoRepository::replaceSpans(const UserId& user, const LocalDate& day,
                                                       const std::vector<SpanWrite>& spans,
                                                       const std::string& embedVersion,
                                                       std::uint64_t bodyStampMs) {
  std::vector<Vectored> stored =
      storage_.replaceSpans(user, day, spans, embedVersion, bodyStampMs);

  std::lock_guard<std::mutex> guard{lock_};
  ++writes_[user.str()];
  auto held = warm_.find(user.str());
  if (held == warm_.end()) return stored;
  // A write in another embedding space says nothing about the one being held, so the held one goes
  // rather than being patched into a corpus that mixes the two.
  if (held->second.embedVersion != embedVersion) {
    warm_.erase(held);
    return stored;
  }
  // The page IS its passages: an empty write is a page with nothing left on it, and the day leaves
  // the corpus entirely.
  if (stored.empty()) held->second.byDay.erase(day.iso());
  else held->second.byDay[day.iso()] = stored;
  return stored;
}

int WarmEchoRepository::loads() const {
  std::lock_guard<std::mutex> guard{lock_};
  return loads_;
}

int WarmEchoRepository::warmUsers() const {
  std::lock_guard<std::mutex> guard{lock_};
  return static_cast<int>(warm_.size());
}

std::vector<EchoUser> WarmEchoRepository::activeSince(std::uint64_t sinceMs) {
  return storage_.activeSince(sinceMs);
}
std::uint64_t WarmEchoRepository::corpusStamp(const UserId& user) {
  return storage_.corpusStamp(user);
}
std::vector<DuePage> WarmEchoRepository::duePages(const UserId& user, std::uint64_t corpusStamp,
                                                  const PipelineVersions& versions) {
  return storage_.duePages(user, corpusStamp, versions);
}
std::optional<DuePage> WarmEchoRepository::duePage(const UserId& user, const LocalDate& day,
                                                   std::uint64_t corpusStamp,
                                                   const PipelineVersions& versions) {
  return storage_.duePage(user, day, corpusStamp, versions);
}
std::optional<DuePage> WarmEchoRepository::pageAt(const UserId& user, const LocalDate& day) {
  return storage_.pageAt(user, day);
}

std::vector<KnownSpan> WarmEchoRepository::spansOf(const UserId& user, const LocalDate& day) {
  return storage_.spansOf(user, day);
}
std::vector<SpanPair> WarmEchoRepository::dismissalsOn(const UserId& user,
                                                       const LocalDate& triggerDay) {
  return storage_.dismissalsOn(user, triggerDay);
}
void WarmEchoRepository::dismissPair(const UserId& user, const LocalDate& triggerDay,
                                     const LocalDate& matchDay) {
  storage_.dismissPair(user, triggerDay, matchDay);
}
void WarmEchoRepository::dismissPage(const UserId& user, const LocalDate& triggerDay) {
  storage_.dismissPage(user, triggerDay);
}
void WarmEchoRepository::dismissOffer(const UserId& user, const LocalDate& day) {
  storage_.dismissOffer(user, day);
}
void WarmEchoRepository::recordSignal(const UserId& user, const LocalDate& triggerDay,
                                      const LocalDate& matchDay, EchoSignal kind) {
  storage_.recordSignal(user, triggerDay, matchDay, kind);
}
void WarmEchoRepository::recordPageSignal(const UserId& user, const LocalDate& triggerDay,
                                          EchoSignal kind) {
  storage_.recordPageSignal(user, triggerDay, kind);
}
void WarmEchoRepository::replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                                       const CuratedEchoes& curated) {
  storage_.replaceEchoes(user, triggerDay, curated);
}
void WarmEchoRepository::clearEchoes(const UserId& user, const LocalDate& triggerDay) {
  storage_.clearEchoes(user, triggerDay);
}

void WarmEchoRepository::recordCuration(const UserId& user, const LocalDate& day,
                                        const CurationOutcome& outcome) {
  storage_.recordCuration(user, day, outcome);
}
std::vector<LocalDate> WarmEchoRepository::inboundPages(const UserId& user,
                                                        const LocalDate& matchDay) {
  return storage_.inboundPages(user, matchDay);
}
std::vector<EchoView> WarmEchoRepository::echoesFor(const UserId& user, const LocalDate& from,
                                                    const LocalDate& to) {
  return storage_.echoesFor(user, from, to);
}
std::vector<LocalDate> WarmEchoRepository::retiredOffers(const UserId& user, const LocalDate& from,
                                                         const LocalDate& to) {
  return storage_.retiredOffers(user, from, to);
}
int WarmEchoRepository::pagesWritten(const UserId& user) {
  return storage_.pagesWritten(user);
}

}
