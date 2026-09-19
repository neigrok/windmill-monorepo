#include "products/gym/adapters/http/CoachImage.h"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_JPEG
#define STBI_ONLY_PNG
#define STBI_NO_STDIO
#define STBI_MAX_DIMENSIONS 4096
#include "third_party/stb/stb_image.h"

#include <memory>
#include <semaphore>
#include <zlib.h>

namespace wm::gym {

std::optional<CoachImage> decodeCoachImage(const std::string& id, const std::string& mediaType,
                                          std::string_view data) {
  if (data.empty() || data.size() > kMaxCoachImageBytes) return std::nullopt;
  if (mediaType == "image/jpeg") {
    if (data.size() < 4 || data.substr(0, 2) != "\xff\xd8" || data.substr(data.size() - 2) != "\xff\xd9") return std::nullopt;
  } else if (mediaType == "image/png") {
    if (data.size() < 32 || data.substr(0, 8) != std::string_view("\x89PNG\r\n\x1a\n", 8) ||
        data.substr(data.size() - 12) != std::string_view("\0\0\0\0IEND\xae\x42\x60\x82", 12)) return std::nullopt;
    const auto word = [&](std::size_t offset) {
      std::uint32_t value = 0;
      for (unsigned index = 0; index < 4; ++index) value = (value << 8) | static_cast<unsigned char>(data[offset + index]);
      return value;
    };
    for (std::size_t offset = 8; offset < data.size();) {
      if (data.size() - offset < 12) return std::nullopt;
      const auto length = word(offset);
      if (length > data.size() - offset - 12) return std::nullopt;
      const auto checksum = crc32(0, reinterpret_cast<const Bytef*>(data.data() + offset + 4), length + 4);
      if (checksum != word(offset + 8 + length)) return std::nullopt;
      offset += length + 12;
    }
  } else return std::nullopt;
  static std::counting_semaphore<2> decoders(2);
  struct Permit {
    explicit Permit(std::counting_semaphore<2>& pool) : pool(pool) { pool.acquire(); }
    ~Permit() { pool.release(); }
    std::counting_semaphore<2>& pool;
  } permit(decoders);
  const auto* bytes = reinterpret_cast<const stbi_uc*>(data.data());
  int width = 0, height = 0, channels = 0;
  if (!stbi_info_from_memory(bytes, static_cast<int>(data.size()), &width, &height, &channels) ||
      width < 1 || height < 1 || width > 4096 || height > 4096 ||
      static_cast<std::uint64_t>(width) * height > 16777216 || channels < 1 || channels > 4) return std::nullopt;
  const std::unique_ptr<stbi_uc, decltype(&stbi_image_free)> pixels(
      stbi_load_from_memory(bytes, static_cast<int>(data.size()), &width, &height, &channels, 0), stbi_image_free);
  if (!pixels) return std::nullopt;
  return CoachImage{CoachAttachment{id, mediaType, width, height, data.size()}, std::string(data)};
}

}
