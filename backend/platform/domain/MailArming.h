#pragma once

#include "platform/domain/Ids.h"

#include <set>
#include <string>

namespace wm {

// The dark-launch gate every product mail stream stands behind — roadmap's weekly reminder and
// journal's nightly nudge today. It is never consulted at DECIDE time, so a sweep's ledger keeps
// recording honest weeks and days while nobody can receive anything; it is consulted at SEND time,
// and again at each product's settings door, so nobody the engine cannot reach is shown a switch
// or allowed to flip one.
//
// `enabled` is the FEATURE's state and `allows` is one person's. Answering the second question with
// the first is the whole of how a dark rollout starts advertising itself. Off ⇒ nobody. On ⇒ only
// the named, and AN EMPTY ALLOWLIST IS NOBODY: `.env.example` and deploy/docker-compose.yml state
// it in the same words, so a change here is a change in all three.
//
// Why nobody, for channels that are already opt-in: the opt-in is DOWNSTREAM of this answer, not
// independent of it. Each product shows its mail panel only to a caller this gate allows — the web
// surface gates the door on the `armed` field the settings API reports from here — so "they asked
// for it" can never be true of anyone we refuse. Empty-means-nobody makes the two variables
// order-independent — neither alone reaches anyone, so there is no way to arm the fleet by
// forgetting the second one, and mail is the one mistake that cannot be walked back. And a
// dark-launch gate is scaffolding: the way it ends is being deleted, not being set to "everybody",
// so its resting state should not double as its terminal state.
//
// One struct on the platform since 2026-08-15. It used to be two — ReminderArming and NudgeArming,
// written twice, checked against each other by hand — and they had drifted into opposite answers on
// the empty list and on id casing before anyone noticed. One name, one rule.
struct MailArming {
  MailArming() = default;
  MailArming(bool enabled, const std::string& allowlistCsv);

  bool allows(const UserId& user) const;

  bool enabled = false;
  std::set<std::string> allowlist;
};

}
