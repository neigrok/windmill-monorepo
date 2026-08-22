#pragma once

#include "platform/domain/Auth.h"  // UnixMs

namespace wm {

// How long the database keeps the rows nobody asked it to keep. Telemetry, feedback and uncaught
// errors are written by anyone who can reach the server, and until now all three grew forever
// (PLATFORM-EDGE-4) — as did expired OAuth codes and tokens, whose digests sat at rest long past
// the moment anything could be done with them (OAUTH-4).
//
// A window of zero or less means KEEP FOREVER, and that is the escape hatch an operator reaches
// for: this is the one sweep in the system whose first run deletes data, so a window that looks
// wrong can be switched off without a rebuild. The binary reads all three windows from the
// environment (WINDMILL_EVENTS_RETENTION_DAYS, WINDMILL_FEEDBACK_RETENTION_DAYS,
// WINDMILL_SERVER_ERROR_RETENTION_DAYS) and the composition root logs what it read at boot.
//
// Both deploy lists carry the three names (.github/workflows/deploy.yml → deploy/docker-compose.yml),
// so a window is a repository variable away in production and never a rebuild.
//
// OAuth rows carry their own window in the row (expires_ms / refresh_expires_ms), so there is
// nothing to configure: a code or token past its expiry is already refused at read time, and the
// sweep is only collecting what the reads have stopped honouring. The one row whose window is NOT
// in its expiry is a rotation tombstone, which is dead when it is stamped and kept only as long as
// reuse detection needs it (OAuthPolicy::spentRefreshTombstoneMs).
//
// User CONTENT is not here and must never be: trees, journal pages, gym rows and accounts are what
// people came for, and a retention pass is not a place from which anyone's work can be deleted.
struct RetentionWindows {
  int eventDays = 180;
  int feedbackDays = 365;
  int serverErrorDays = 180;
  // The ceiling on one pass per table. A sweep that tried to delete a year of telemetry in one
  // statement would hold a lock and bloat the table it is there to keep small; the heartbeat comes
  // back in an hour and takes the next slice.
  int batch = 5000;
};

// What one pass removed, per table — the sweep logs it, so the first production run is readable
// in the log rather than inferred from a shrinking disk. `ran` is false when another process in
// the fleet held the sweep lock: nothing was looked at, which is not the same as nothing being due.
struct RetentionReport {
  bool ran = false;
  int events = 0;
  int feedback = 0;
  int serverErrors = 0;
  int oauthCodes = 0;
  int oauthTokens = 0;
  int oauthClients = 0;

  int rows() const {
    return events + feedback + serverErrors + oauthCodes + oauthTokens + oauthClients;
  }
};

// The one store that forgets. Retention is a single policy over several tables of one database, so
// it is one seam rather than a purge method bolted onto each repository — every table it touches is
// a table whose rows nobody owns, and stating that in one place is what keeps a product's rows out.
struct RetentionStore {
  virtual ~RetentionStore() = default;

  virtual RetentionReport purge(const RetentionWindows& windows, UnixMs now) = 0;
};

}
