# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0
#
# Engine-independent build of the PlayerThree C++ core (the Unreal plugin's PlayerThreeCore module), the Tug of War
# CLI sample and the tests. Unreal builds the same sources through PlayerThreeCore.Build.cs instead.
cmake_minimum_required(VERSION 3.18)
project(PlayerThreeUnreal LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(P3_CORE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/Plugins/PlayerThree/Source/PlayerThreeCore)
add_library(playerthree_core STATIC
  ${P3_CORE_DIR}/Private/Adapter.cpp
  ${P3_CORE_DIR}/Private/Framing.cpp
  ${P3_CORE_DIR}/Private/Manifest.cpp
  ${P3_CORE_DIR}/Private/Schema.cpp
  ${P3_CORE_DIR}/Private/Sidecar.cpp
  ${P3_CORE_DIR}/Private/Transport.cpp)
target_include_directories(playerthree_core PUBLIC ${P3_CORE_DIR}/Public)
if(MSVC)
  target_compile_options(playerthree_core PRIVATE /W4)
else()
  target_compile_options(playerthree_core PRIVATE -Wall -Wextra -Wpedantic -Wshadow)
endif()

add_library(tug_of_war STATIC Samples/TugOfWar/TugOfWar.cpp)
target_include_directories(tug_of_war PUBLIC Samples/TugOfWar)
target_link_libraries(tug_of_war PUBLIC playerthree_core)

add_executable(p3-tug Samples/TugCli/main.cpp)
target_link_libraries(p3-tug PRIVATE tug_of_war)

include(CTest)
if(BUILD_TESTING)
  # The conformance fixture and runner live in the sidecar package of the PlayerThree checkout around this SDK.
  get_filename_component(P3_REPO_DEFAULT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
  set(P3_REPO "${P3_REPO_DEFAULT}" CACHE PATH "PlayerThree checkout providing packages/sidecar/conformance")
  # A Windows -DP3_REPO=C:\… keeps its backslashes, which would become escapes in the fixture path's C string literal.
  file(TO_CMAKE_PATH "${P3_REPO}" P3_REPO)
  set(P3_CONFORMANCE_DIR "${P3_REPO}/packages/sidecar/conformance")
  option(P3_CONFORMANCE "Run the CLI sample under the sidecar conformance runner (node, pnpm install in P3_REPO)" ON)

  find_package(Threads REQUIRED)
  set(P3_TESTS framing schema sidecar)
  if(NOT WIN32)
    list(APPEND P3_TESTS transport)  # real Unix sockets and spawned processes
  endif()
  foreach(name ${P3_TESTS})
    add_executable(test_${name} Tests/${name}_test.cpp)
    target_include_directories(test_${name} PRIVATE Tests)
    target_link_libraries(test_${name} PRIVATE tug_of_war Threads::Threads)
    add_test(NAME ${name} COMMAND test_${name})
  endforeach()
  target_compile_definitions(test_schema PRIVATE P3_TUG_MANIFEST_FIXTURE="${P3_CONFORMANCE_DIR}/tug.manifest.json")

  if(P3_CONFORMANCE)
    find_program(NODE_EXECUTABLE node REQUIRED)
    set(P3_RUNNER ${P3_CONFORMANCE_DIR}/run.ts)
    # stdio: the engine spawns the runner in place of the sidecar and exits with its verdict.
    add_test(NAME conformance_stdio COMMAND p3-tug -- ${NODE_EXECUTABLE} ${P3_RUNNER} --stdio)
    # socket: the runner listens and spawns the engine with PLAYERTHREE_SIDECAR_SOCKET.
    add_test(NAME conformance_socket COMMAND ${NODE_EXECUTABLE} ${P3_RUNNER} --socket -- $<TARGET_FILE:p3-tug>)
    set_tests_properties(conformance_stdio conformance_socket PROPERTIES TIMEOUT 180)
  endif()
endif()
