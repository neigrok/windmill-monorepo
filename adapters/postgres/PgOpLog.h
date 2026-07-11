#pragma once

#include "ports/OpLog.h"

#include <string>

namespace wm {

class PgOpLog : public OpLog {
public:
  explicit PgOpLog(std::string connString);

  void append(const TreeId& tree, const AppliedOp& op) override;
  std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const override;

private:
  std::string connString_;
};

}
