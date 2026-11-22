#pragma once

#include <map>
#include <string>
#include <string_view>

// The words the model reads in a turn: packages/api-contract/gym/coach, which every app ships too and
// the build embeds here, so the server's Coach and the devices' speak the same bytes.

namespace wm::gym::coach {

class CoachWords {
public:
  // Throws std::invalid_argument when a file is not the shape its README states.
  CoachWords(std::string_view prompt, std::string_view firstContent, std::string_view refusals);

  // The words this binary was built with.
  static const CoachWords& shipped();

  const std::string& prompt() const { return prompt_; }
  // Throws std::out_of_range for an ability that is not a context read.
  const std::string& contextLead(const std::string& ability) const { return contextLeads_.at(ability); }
  const std::string& earlierMarker() const { return earlierMarker_; }
  const std::string& speaker(const std::string& role) const { return role == "coach" ? coach_ : lifter_; }
  const std::string& pictureOnlyQuestion() const { return pictureOnlyQuestion_; }
  // The sentence beside a refusal code, `{target}` filled when the sentence names one. Throws
  // std::out_of_range for a code with no sentence.
  std::string refusal(const std::string& code, std::string_view target = {}) const;

private:
  std::string prompt_;
  std::map<std::string, std::string> contextLeads_;
  std::string earlierMarker_;
  std::string lifter_;
  std::string coach_;
  std::string pictureOnlyQuestion_;
  std::map<std::string, std::string> refusals_;
};

}
