cmake_minimum_required(VERSION 3.16)
project(ps5-helper C CXX)

# Build only chiaki's protocol library: no GUI, no CLI, no decoders.
# The helper forwards the PS5's encoded video/audio untouched.
set(CHIAKI_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_CLI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_GUI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_STEAM_SHORTCUT OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_SETSU OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_STEAMDECK_NATIVE OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_SPEEX OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_FFMPEG_DECODER OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_PI_DECODER OFF CACHE STRING "" FORCE)
set(CHIAKI_USE_SYSTEM_JERASURE OFF CACHE STRING "" FORCE)
set(CHIAKI_USE_SYSTEM_NANOPB OFF CACHE STRING "" FORCE)
set(CHIAKI_USE_SYSTEM_CURL OFF CACHE STRING "" FORCE)

# Homebrew can have several OpenSSL versions at once, and the newest one's
# headers sit in the shared include folder (/opt/homebrew/include) that other
# libraries add to the search path. Compiling against those while linking
# OpenSSL 3 fails with missing symbols. So the headers of the OpenSSL that is
# linked go first, for chiaki and the libraries it bundles alike. They are
# reached through a folder of our own: CMake would otherwise merge the path
# with the one OpenSSL's package adds, and search it after the shared folder.
find_package(OpenSSL 3 REQUIRED)
set(OPENSSL_FIRST_DIR "${CMAKE_BINARY_DIR}/openssl-first")
file(MAKE_DIRECTORY "${OPENSSL_FIRST_DIR}")
file(REMOVE "${OPENSSL_FIRST_DIR}/openssl")
file(CREATE_LINK "${OPENSSL_INCLUDE_DIR}/openssl" "${OPENSSL_FIRST_DIR}/openssl" SYMBOLIC)
include_directories(BEFORE "${OPENSSL_FIRST_DIR}")

add_subdirectory(../vendor/chiaki-ng chiaki EXCLUDE_FROM_ALL)

add_executable(ps5-helper main.c)
target_link_libraries(ps5-helper chiaki-lib)
set_target_properties(ps5-helper PROPERTIES C_STANDARD 11)
