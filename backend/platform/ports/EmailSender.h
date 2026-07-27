#pragma once

#include "platform/domain/Auth.h"
#include "products/roadmap/domain/Reminders.h"

#include <array>
#include <functional>
#include <string>

namespace wm {

// The weekly reminder, already rendered: every field is a finished string or number, so the
// mailer only binds them to template variables and the engine keeps every decision — including
// the counted sentences, which are product copy and are therefore worded in the pure core
// (domain/Reminders.h) where a test can reach them. `readyPhrase` counts the featured tree's
// ready steps, `moreOnTree` the ones this mail did not have room to name, and `moreReady` the
// OTHER trees also waiting; each is empty when it has nothing to say.
//
// The step slots are FIXED rather than a list the provider iterates — the template documents
// this fallback, kMaxSteps is the cap anyway, and it removes a dependency on provider-side
// looping. An empty label is an unused slot. `colorHex` is one of the six hues rendered
// server-side, because it lands inside a style attribute where markup stripping does not
// protect it.
struct ReminderMail {
  struct Step {
    std::string label;
    std::string colorHex;
  };

  std::string treeName;
  std::string treeUrl;
  std::string settingsUrl;
  std::string pauseUrl;
  // The RFC 8058 one-click target — a mail client POSTs it when the reader presses "unsubscribe".
  // Distinct from pauseUrl (a human page reached from a body link); this is a bare endpoint, so its
  // secret rides the query, not a fragment. It becomes the List-Unsubscribe header, not a variable.
  std::string unsubscribeUrl;
  int done = 0;
  int total = 0;
  std::string readyPhrase;
  std::string moreOnTree;
  std::string moreReady;
  std::array<Step, kMaxSteps> steps;
};

// The daily journal nudge, already rendered. The body line is fixed and lives in the provider's
// 'journal-nudge' template ("The house is quiet. Three minutes?") — it never travels here, so a
// bad word can't ride in; the mailer only binds the three links. Platform-neutral strings, so this
// port stays free of any journal type. settingsUrl reaches the nudge panel, pauseUrl is the "pause
// for a week" page, unsubscribeUrl is the RFC 8058 one-click target that becomes the header.
struct JournalNudgeMail {
  std::string settingsUrl;
  std::string pauseUrl;
  std::string unsubscribeUrl;
};

// The transactional email Windmill sends — one method per mail it can say. sendMagicLink
// renders the provider's 'magic-link' template with `magic_link` bound to the sign-in URL;
// sendForkLink renders 'magic-link-fork', which also names the tree the link will plant
// (`tree_title`) and its meta line (`tree_meta`, e.g. "12 steps"). Both are asynchronous so
// the slow provider call never parks a request loop: done fires exactly once with the
// delivery outcome — true on a 2xx, false on any failure or timeout (the edge turns that
// into the doc's only brick, "can't reach windmill.works") — and may fire on the sender's
// own loop thread rather than the caller's, exactly like PlanComposer.
struct EmailSender {
  virtual ~EmailSender() = default;
  virtual void sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                             std::function<void(bool)> done) = 0;
  virtual void sendForkLink(const Email& to, const std::string& magicLinkUrl,
                            const std::string& treeTitle, const std::string& treeMeta,
                            std::function<void(bool)> done) = 0;
  // The weekly reminder ('reminder'). Same asynchronous contract as the two above: done fires
  // exactly once with the delivery verdict, and the sweep only stamps a row as sent on a true.
  virtual void sendReminder(const Email& to, const ReminderMail& mail,
                            std::function<void(bool)> done) = 0;
  // The daily journal nudge ('journal-nudge'). Same asynchronous contract; the sweep stamps a row
  // as sent only on a true.
  virtual void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                                std::function<void(bool)> done) = 0;
};

}
