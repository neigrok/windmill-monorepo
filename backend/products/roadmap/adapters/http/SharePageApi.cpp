#include "products/roadmap/adapters/http/SharePageApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/PageShell.h"
#include "platform/application/WriteObservation.h"
#include "platform/domain/Origin.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/WebAddress.h"

#include <exception>
#include <mutex>
#include <optional>

namespace wm {

SharePageApi::SharePageApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
                           std::shared_ptr<AuthService> auth, std::shared_ptr<OgVideoRepository> videos,
                           std::string webRoot, std::string appOrigin, std::shared_ptr<EngineReadModels> engine,
                           std::shared_ptr<FailureReporter> failures)
    : registry_(std::move(registry)), trees_(std::move(trees)), auth_(std::move(auth)),
      videos_(std::move(videos)), webRoot_(std::move(webRoot)), appOrigin_(std::move(appOrigin)), engine_(std::move(engine)),
      failures_(std::move(failures)) {}

std::string SharePageApi::renderShell(const std::string& shell, const std::string& origin, const std::string& title,
                                      std::size_t steps, Visibility visibility, const std::string& id,
                                      const ForkLineage& lineage, bool hasVideo) {
  const std::string safeTitle = htmlEscape(title.empty() ? "Untitled tree" : title);
  const std::string url = htmlEscape(treeAddress(WebTree{origin, TreeId{id}, Opener::reader}));
  const std::string stepPhrase = std::to_string(steps) + (steps == 1 ? " step." : " steps.");
  std::string description;
  if (lineage.isFork && !lineage.sourceTitle.empty())
    description = "A fork of \xE2\x80\x9C" + htmlEscape(lineage.sourceTitle) + "\xE2\x80\x9D \xE2\x80\x94 " + stepPhrase;
  else if (lineage.isFork)
    description = "A forked Windmill skill tree \xE2\x80\x94 " + stepPhrase;
  else
    description = "A Windmill skill tree \xE2\x80\x94 " + stepPhrase;
  if (lineage.forkCount > 0)
    description += " Forked " + std::to_string(lineage.forkCount) + (lineage.forkCount == 1 ? " time." : " times.");
  const std::string robots =
      visibility == Visibility::public_ ? "index, follow, max-image-preview:large" : "noindex";
  const std::string image = htmlEscape(normalizedOrigin(origin) + "/og/" + id + ".png");

  std::string meta;
  meta += "\n\n    <!-- Rewritten for this shared tree by windmill_server (path-share). -->\n";
  meta += "    <title>" + safeTitle + " \xE2\x80\x94 Windmill</title>\n";
  meta += "    <meta name=\"description\" content=\"" + description + "\" />\n\n";
  meta += "    <link rel=\"canonical\" href=\"" + url + "\" />\n";
  meta += "    <meta name=\"robots\" content=\"" + robots + "\" />\n\n";
  meta += "    <meta property=\"og:type\" content=\"website\" />\n";
  meta += "    <meta property=\"og:site_name\" content=\"Windmill\" />\n";
  meta += "    <meta property=\"og:title\" content=\"" + safeTitle + "\" />\n";
  meta += "    <meta property=\"og:description\" content=\"" + description + "\" />\n";
  meta += "    <meta property=\"og:url\" content=\"" + url + "\" />\n";
  meta += "    <meta property=\"og:image\" content=\"" + image + "\" />\n";
  meta += "    <meta property=\"og:image:type\" content=\"image/png\" />\n";
  meta += "    <meta property=\"og:image:width\" content=\"1200\" />\n";
  meta += "    <meta property=\"og:image:height\" content=\"630\" />\n";
  if (hasVideo) {
    const std::string video = htmlEscape(normalizedOrigin(origin) + "/v1/trees/" + id + "/og-video");
    meta += "    <meta property=\"og:video\" content=\"" + video + "\" />\n";
    meta += "    <meta property=\"og:video:secure_url\" content=\"" + video + "\" />\n";
    meta += "    <meta property=\"og:video:type\" content=\"video/mp4\" />\n";
    meta += "    <meta property=\"og:video:width\" content=\"1080\" />\n";
    meta += "    <meta property=\"og:video:height\" content=\"1080\" />\n";
  }
  meta += "    <meta property=\"og:locale\" content=\"en_US\" />\n\n";
  meta += "    <meta name=\"twitter:card\" content=\"summary_large_image\" />\n";
  meta += "    <meta name=\"twitter:title\" content=\"" + safeTitle + "\" />\n";
  meta += "    <meta name=\"twitter:description\" content=\"" + description + "\" />\n";
  meta += "    <meta name=\"twitter:image\" content=\"" + image + "\" />\n    ";

  return spliceBetween(shell, "<!-- meta:unfurl:start -->", "<!-- meta:unfurl:end -->", meta);
}

std::optional<SharedRoadmap> SharePageApi::sharedOf(const std::string& id, const std::optional<UserId>& caller) {
  if (engine_) {
    WriteObservation observation{"roadmap.share.read", "roadmap", "share", "", failures_.get()};
    WriteContext context{observation};
    try {
      std::optional<SharedRoadmap> shared;
      if (const std::optional<ReadableRoadmap> roadmap = engine_->open(TreeId{id}, caller)) shared = engine_->shared(*roadmap);
      observation.skip();
      return shared;
    } catch (const std::exception& failure) {
      // An infrastructure failure leaves it unreadable, so the shell is served verbatim, and is reported.
      observation.fail(failure);
      return std::nullopt;
    }
  }
  {
    bool readable = false;
    bool subtree = false;
    std::string title;
    std::size_t steps = 0;
    Visibility visibility = Visibility::private_;
    {
      std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{id}));
      WriteObservation observation{"roadmap.share.read", "roadmap", "share", "", failures_.get()};
      // The reads made for it are of its request: a failure one of them reports is the request's one Issue.
      WriteContext context{observation};
      try {
        // Authorize on the stored row BEFORE opening: this door is anonymous, so opening first would
        // let a stranger pull the lattice of any id they guess off disk and into memory.
        const std::optional<TreeAccess> access = registry_->accessOf(TreeId{id});
        if (access && canRead(caller, access->owner, access->visibility)) {
          TreeRoom* room = registry_->open(TreeId{id});
          if (room) {
            readable = true;
            subtree = room->parent().has_value();
            if (!subtree) title = room->title().value;  // a subtree's own register is read by nothing
            steps = room->snapshot().nodes.size();
            visibility = room->visibility();
          }
        }
        observation.skip();  // a read that does not fail leaves no completion line
      } catch (const std::exception& failure) {
        // An infrastructure failure leaves it unreadable, so the shell is served verbatim, and is reported.
        observation.fail(failure);
      }
    }

    // Taken OUTSIDE the room strand, and only for a readable tree. A subtree is named by its owning step's label, read
    // through its parent; a tree that went away meanwhile, or a read that failed, leaves the shell verbatim, the failure
    // reported as the place read's.
    if (readable && subtree) {
      WriteObservation observation{"roadmap.tree.place", "roadmap", "share", "", failures_.get()};
      try {
        const std::optional<Place> place = trees_->placeOf(TreeId{id});
        readable = place.has_value();
        if (place) title = place->title;
        observation.skip();
      } catch (const std::exception& failure) {
        observation.fail(failure);
        readable = false;
      }
    }
    if (!readable) return std::nullopt;
    return SharedRoadmap{title, steps, visibility, trees_->loadForkLineage(TreeId{id})};
  }
}

void SharePageApi::page(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  const std::string shell = readWebFile(webRoot_, "index.html");
  if (shell.empty()) {
    // No shell to serve: bounce the human to the hash route so the tree still opens.
    callback(htmlPage("<!doctype html><meta http-equiv=\"refresh\" content=\"0;url=/#/t/"
                      + htmlEscape(id) + "\">"));
    return;
  }

  // A page shows an anonymous caller public content alone, so credentials that serve no account read as anonymous.
  const std::optional<SharedRoadmap> shared = sharedOf(id, SentCaller::of(req, *auth_).account());
  const bool hasVideo = shared && videos_->has(id);
  // Only a roadmap anyone with its address may read is one page for everyone. Every other answer is the caller's alone,
  // the shell an absent id gets included, so it reads like the shell an unreadable one gets.
  const Audience audience = shared && opensToReaders(shared->visibility) ? Audience::everyone : Audience::caller;
  callback(htmlPage(shared ? renderShell(shell, appOrigin_, shared->title, shared->steps, shared->visibility, id, shared->lineage, hasVideo)
                           : shell,
                    audience));
}

}
