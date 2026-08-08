#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/ports/OpLog.h"

#include <memory>
#include <string>

namespace wm {

class PgOpLog : public OpLog {
public:
  explicit PgOpLog(std::shared_ptr<PgPool> pool);

  void append(const TreeId& tree, const AppliedOp& op) override;
  std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
