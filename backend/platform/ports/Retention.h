#pragma once

#include "platform/domain/Auth.h"  // UnixMs

namespace wm {

// How long the database keeps rows nobody owns. A window of zero or less means keep forever.
// The three windows come from WINDMILL_EVENTS_RETENTION_DAYS, WINDMILL_FEEDBACK_RETENTION_DAYS and
// WINDMILL_SERVER_ERROR_RETENTION_DAYS. OAuth rows carry their own window in the row. User content
// is never swept from here.
struct RetentionWindows {
  int eventDays = 180;
  int feedbackDays = 365;
  int serverErrorDays = 180;
  // Ceiling on rows removed per table per pass; the next heartbeat takes the next slice.
  int batch = 5000;
};

// `ran` is false when another process held the sweep lock: nothing was looked at, which is not
// the same as nothing being due.
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

struct RetentionStore {
  virtual ~RetentionStore() = default;

  virtual RetentionReport purge(const RetentionWindows& windows, UnixMs now) = 0;
};

}
