#pragma once

#include "platform/domain/Ids.h"

namespace wm {

// Whether an account holds anything a merge would destroy. Every product must be represented — a
// product missing from the probe set reports an account empty that is not.
struct AccountFootprint {
  virtual ~AccountFootprint() = default;
  virtual bool anyData(const UserId& userId) = 0;
};

}
