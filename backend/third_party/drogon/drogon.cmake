# The Drogon every build links: one pinned release with the patches beside this file, built once into a prefix and
# reused while the pin and the patches stay the same. Runs as include() from CMakeLists.txt, and as
# `cmake -DWM_DROGON_PREFIX=<dir> -P drogon.cmake` from the image's own layer (Dockerfile).

set(WM_DROGON_VERSION 1.9.13)
set(WM_DROGON_ARCHIVE "https://github.com/drogonframework/drogon/archive/4c5430757ea5451a7c38fbbef4b4bef7dbb47f2f.tar.gz")
set(WM_DROGON_ARCHIVE_SHA256 d1d569734e77c1841d840ed9fd1bfeb3b109cab00598e3880f5aec7261e79bf4)
# The trantor commit Drogon's own submodule pins at that release.
set(WM_TRANTOR_ARCHIVE "https://github.com/an-tao/trantor/archive/63a4e5e164e219dc3bf30cdbfa1462ae5602fa97.tar.gz")
set(WM_TRANTOR_ARCHIVE_SHA256 5ced9bc71563a1af734ed57acc368b324e9f5545b0b0bec187db581309e3a458)
set(WM_DROGON_OPTIONS
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_CXX_STANDARD=20
    -DBUILD_SHARED_LIBS=OFF
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON
    -DBUILD_CTL=OFF
    -DBUILD_EXAMPLES=OFF
    -DBUILD_ORM=OFF
    -DBUILD_YAML_CONFIG=OFF
    -DBUILD_TESTING=OFF)
# Included by a configure, a build dir configures again when a patch is added, removed or edited, and so builds the new
# Drogon. Script mode has no build dir to tell.
if(CMAKE_SCRIPT_MODE_FILE)
  file(GLOB WM_DROGON_PATCHES "${CMAKE_CURRENT_LIST_DIR}/patches/*.patch")
else()
  file(GLOB WM_DROGON_PATCHES CONFIGURE_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/patches/*.patch")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${WM_DROGON_PATCHES})
endif()
list(SORT WM_DROGON_PATCHES)

# The build's identity: this script, which holds the pin and the options, and every patch's text. A prefix that holds
# another build is built again.
function(wm_drogon_key out)
  file(SHA256 "${CMAKE_CURRENT_FUNCTION_LIST_FILE}" text)
  foreach(patch IN LISTS WM_DROGON_PATCHES)
    file(SHA256 "${patch}" patch_sha256)
    string(APPEND text " ${patch_sha256}")
  endforeach()
  string(SHA256 key "${text}")
  set(${out} "${key}" PARENT_SCOPE)
endfunction()

function(wm_drogon_run)
  execute_process(COMMAND ${ARGN} RESULT_VARIABLE result)
  if(NOT result EQUAL 0)
    string(REPLACE ";" " " command "${ARGN}")
    message(FATAL_ERROR "Building the patched Drogon failed at: ${command}")
  endif()
endfunction()

function(wm_drogon_build prefix key)
  set(work "${prefix}.work")
  file(REMOVE_RECURSE "${work}")
  file(DOWNLOAD "${WM_DROGON_ARCHIVE}" "${work}/drogon.tar.gz" EXPECTED_HASH SHA256=${WM_DROGON_ARCHIVE_SHA256} TLS_VERIFY ON)
  file(DOWNLOAD "${WM_TRANTOR_ARCHIVE}" "${work}/trantor.tar.gz" EXPECTED_HASH SHA256=${WM_TRANTOR_ARCHIVE_SHA256} TLS_VERIFY ON)
  file(ARCHIVE_EXTRACT INPUT "${work}/drogon.tar.gz" DESTINATION "${work}/unpacked")
  file(ARCHIVE_EXTRACT INPUT "${work}/trantor.tar.gz" DESTINATION "${work}/unpacked")
  file(GLOB drogon_source "${work}/unpacked/drogon-*")
  file(GLOB trantor_source "${work}/unpacked/trantor-*")
  file(RENAME "${drogon_source}" "${work}/src")
  file(REMOVE_RECURSE "${work}/src/trantor")
  file(RENAME "${trantor_source}" "${work}/src/trantor")

  # A repository of its own, so `git apply` reads every path from the source root wherever the prefix lies.
  wm_drogon_run(git -C "${work}/src" init --quiet)
  foreach(patch IN LISTS WM_DROGON_PATCHES)
    execute_process(COMMAND git -C "${work}/src" apply "${patch}" RESULT_VARIABLE applied)
    if(NOT applied EQUAL 0)
      message(FATAL_ERROR "${patch} does not apply to Drogon ${WM_DROGON_VERSION}")
    endif()
  endforeach()

  cmake_host_system_information(RESULT cores QUERY NUMBER_OF_LOGICAL_CORES)
  wm_drogon_run(${CMAKE_COMMAND} -S "${work}/src" -B "${work}/build" ${WM_DROGON_OPTIONS} "-DCMAKE_INSTALL_PREFIX=${prefix}")
  wm_drogon_run(${CMAKE_COMMAND} --build "${work}/build" --parallel ${cores})
  file(REMOVE_RECURSE "${prefix}")
  wm_drogon_run(${CMAKE_COMMAND} --install "${work}/build")
  file(WRITE "${prefix}/windmill-drogon.key" "${key}")
  file(REMOVE_RECURSE "${work}")
endfunction()

# Builds into `prefix` unless it holds this build already, one process at a time.
function(wm_drogon_ensure prefix)
  wm_drogon_key(key)
  get_filename_component(parent "${prefix}" DIRECTORY)
  file(MAKE_DIRECTORY "${parent}")
  file(LOCK "${prefix}.lock" GUARD FUNCTION TIMEOUT 3600)
  set(built "")
  if(EXISTS "${prefix}/windmill-drogon.key")
    file(READ "${prefix}/windmill-drogon.key" built)
  endif()
  if(NOT built STREQUAL key)
    message(STATUS "Building Drogon ${WM_DROGON_VERSION} with the patches in ${CMAKE_CURRENT_FUNCTION_LIST_DIR}/patches")
    wm_drogon_build("${prefix}" "${key}")
  endif()
endfunction()

# A cache of the user's, shared by every checkout, one directory per build.
function(wm_drogon_default_prefix out)
  wm_drogon_key(key)
  string(SUBSTRING "${key}" 0 12 key)
  set(cache "$ENV{XDG_CACHE_HOME}")
  if(NOT cache)
    set(cache "$ENV{HOME}/.cache")
  endif()
  set(${out} "${cache}/windmill/drogon-${WM_DROGON_VERSION}-${key}" PARENT_SCOPE)
endfunction()

if(NOT WM_DROGON_PREFIX)
  wm_drogon_default_prefix(WM_DROGON_PREFIX)
endif()
wm_drogon_ensure("${WM_DROGON_PREFIX}")
message(STATUS "Drogon ${WM_DROGON_VERSION}, patched, from ${WM_DROGON_PREFIX}")
