#include "platform/adapters/http/PageShell.h"

#include <fstream>
#include <sstream>

namespace wm {

std::string htmlEscape(const std::string& text) {
  std::string out;
  out.reserve(text.size());
  for (char c : text) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out += c;
    }
  }
  return out;
}

std::string readWebFile(const std::string& webRoot, const std::string& name) {
  if (webRoot.empty()) return {};
  std::ifstream file(webRoot + "/" + name, std::ios::binary);
  if (!file) return {};
  std::ostringstream buffer;
  buffer << file.rdbuf();
  return buffer.str();
}

std::string spliceBetween(const std::string& shell, const std::string& startTag,
                          const std::string& endTag, const std::string& content) {
  const std::size_t start = shell.find(startTag);
  const std::size_t end = shell.find(endTag);
  if (start == std::string::npos || end == std::string::npos || end < start) return shell;
  return shell.substr(0, start + startTag.size()) + content + shell.substr(end);
}

drogon::HttpResponsePtr htmlPage(std::string body) {
  auto resp = drogon::HttpResponse::newHttpResponse();
  resp->setStatusCode(drogon::k200OK);
  resp->setContentTypeCode(drogon::CT_TEXT_HTML);
  resp->addHeader("Cache-Control", "public, max-age=300");
  resp->setBody(std::move(body));
  return resp;
}

}
