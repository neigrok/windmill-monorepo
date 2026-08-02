#pragma once

#include "platform/domain/Auth.h"

#include <memory>
#include <string>

namespace wm {

// What ONE product does when the provider tells us a mailbox is gone. The verdict is platform's and
// is made once (platform/domain/Mail.h); the writes are each product's, because only a product
// knows which of its rows means "stop". A product that sends no mail implements nothing and
// contributes nothing — gym has no mail today and needs no port to say so.
//
// Suppression is a SENDING state and only that. Nothing in the sign-in path may read it: the magic
// link is the one door back into an account, and someone who fixes their mailbox must be able to
// walk through it and switch their mail on again. It is never an edit to what its owner asked for
// either, so lifting the flag restores their choice rather than a default.
struct MailSuppression {
  virtual ~MailSuppression() = default;

  // Stop this product's mail to that address, and answer whether there was anyone to stop. Keyed by
  // ADDRESS because that is all a provider event carries, and idempotent by construction — the
  // value written is a constant, so a redelivered webhook performs the identical write, which is
  // the whole of why no dedup table exists. False means no live account owns that address: worth
  // logging, never worth answering with, since a door that told strangers apart from members would
  // be an account-existence oracle.
  virtual bool stopMailing(const Email& address) = 0;
};

// One product's mail stream, named where it is registered so a write that fails says whose mail is
// still going to a dead mailbox. The composition root (platform/infra/main.cpp) assembles the list,
// exactly as it already names every product's table for PgAccountFootprint: EVERY product that
// sends mail must appear, and one missing keeps writing to an address the provider has already
// called dead — spending the deliverability the magic link depends on.
struct MailStream {
  std::string name;                             // "roadmap reminder", "journal nudge"
  std::shared_ptr<MailSuppression> suppression;
};

}
