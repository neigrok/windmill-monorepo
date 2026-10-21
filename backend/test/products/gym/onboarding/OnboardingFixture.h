#pragma once

#include "products/gym/onboarding/OnboardingService.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/json/JsonText.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"

#include <atomic>
#include <map>
#include <mutex>

namespace wm::gym::onboardingtest {

struct Installations : AiInstallationRepository {
  std::map<std::string,AiInstallationRow> rows;
  AiInstallationCode code = AiInstallationCode::Ok;
  int admissions = 0;
  std::optional<AiInstallationRow> find(const std::string& digest) override {
    const auto it = rows.find(digest);
    return it == rows.end() ? std::nullopt : std::optional(it->second);
  }
  AiInstallationCode issue(const AiInstallationRow& row, const AiInstallationNetwork&) override {
    rows.emplace(row.tokenDigest,row);
    return AiInstallationCode::Ok;
  }
  AiInstallationCode admit(const std::string&, const std::string&, const AiInstallationNetwork&, long long) override {
    ++admissions;
    return code;
  }
  void prune(long long) override {}
};

struct Records : OnboardingRepository {
  std::mutex mutex;
  std::map<std::pair<std::string,std::string>,OnboardingRecord> rows;
  OnboardingClaim claim(const OnboardingRecord& proposed) override {
    std::lock_guard lock(mutex);
    const auto key = std::pair(proposed.deviceId,proposed.requestId);
    const auto found = rows.find(key);
    if (found != rows.end()) {
      if (found->second.inputHash != proposed.inputHash) return {{},false,"request_conflict"};
      return {expireOnboarding(found->second,proposed.createdAtMs),false,{}};
    }
    rows.emplace(key,proposed);
    return {proposed,true,{}};
  }
  std::optional<OnboardingRecord> get(const std::string& device,const std::string& request,long long now) override {
    std::lock_guard lock(mutex);
    const auto found = rows.find({device,request});
    if (found==rows.end()) return std::nullopt;
    return expireOnboarding(found->second,now);
  }
  bool finish(const OnboardingRecord& result,long long now) override {
    std::lock_guard lock(mutex);
    auto& record=rows.at({result.deviceId,result.requestId});
    if (record.state!="pending" || now>=record.leaseUntilMs) return false;
    record=result;
    record.terminalAtMs=now;
    return true;
  }
  void expire(long long now) override {
    std::lock_guard lock(mutex);
    for (auto& [id,record]:rows) record=expireOnboarding(record,now);
  }
};

struct Catalog : CatalogRepository {
  std::vector<Exercise> seeds{{ExerciseId{"bench-press"},"Bench Press",Pattern::press,Equipment::barbell,2.5,false}};
  std::atomic<int> ownerReads=0;
  std::atomic<int> seedReads=0;
  std::vector<Exercise> catalog(const UserId&) override { ++ownerReads; throw std::runtime_error("private catalog must not be read"); }
  std::vector<Exercise> seedCatalog() override { ++seedReads; return seeds; }
  std::optional<Exercise> exerciseUpdate(const UserId&, const std::string&) override { return std::nullopt; }
};

struct Model : OnboardingModel {
  bool available=true;
  std::atomic<int> calls=0;
  std::function<void()> before;
  std::string error;
  bool configured() const override { return available; }
  OnboardingAnswer generate(const AiInstallationPrincipal&,const std::string&,const OnboardingIn&,const std::vector<Exercise>&) override {
    ++calls;
    if (before) before();
    if (!error.empty()) return {{},error};
    return {{{"Push",{RoutineEntry{1,ExerciseId{"bench-press"},{SetTarget{8,std::nullopt}},120}}}}, {}};
  }
};

struct Failures : FailureReporter {
  std::mutex mutex;
  std::vector<std::string> reports;
  void report(const std::string& kind,const std::string& where,const std::string& detail) override {
    std::lock_guard lock(mutex);
    reports.push_back(kind+":"+where+":"+detail);
  }
};

struct Harness {
  fake::FakeClock clock;
  OpenSslTokenGenerator tokens;
  fake::FakeAiBudgetRepository budgetRepository;
  AiBudgetLimits limits;
  std::shared_ptr<AiBudgetService> budgets=std::make_shared<AiBudgetService>(budgetRepository,[this]{return limits;},[this]{return clock.now;});
  Installations installationRepository;
  std::shared_ptr<AiInstallations> installations=std::make_shared<AiInstallations>(installationRepository,budgets,tokens,clock,std::string(64,'k'));
  AiInstallationIssue issue=installations->issue("127.0.0.1");
  std::shared_ptr<Records> records=std::make_shared<Records>();
  std::shared_ptr<Model> model=std::make_shared<Model>();
  std::shared_ptr<Catalog> catalog=std::make_shared<Catalog>();
  std::shared_ptr<Failures> failures=std::make_shared<Failures>();
  std::shared_ptr<OnboardingService> service=std::make_shared<OnboardingService>(records,model,catalog,installations,tokens,clock,failures);
};

}
