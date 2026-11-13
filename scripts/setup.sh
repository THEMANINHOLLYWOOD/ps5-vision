#!/usr/bin/env bash
# One-time setup on the Mac: installs build tools, fetches chiaki-ng (the
# open-source Remote Play library) and builds the small helper that talks to
# the PS5. Safe to run again; it only redoes what is missing.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
CHIAKI_TAG="v1.10.1"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This setup script is for macOS. On other systems, install the packages" >&2
  echo "listed below with your package manager and run the cmake step by hand." >&2
  exit 1
fi
if ! command -v brew >/dev/null; then
  echo "Homebrew is required: https://brew.sh" >&2
  exit 1
fi
if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 20')" != "true" ]; then
  echo "Node.js 20 or newer is required: brew install node" >&2
  exit 1
fi
# Use Homebrew's tools (protoc in particular) ahead of any other copies.
export PATH="$(brew --prefix)/bin:$PATH"

echo "==> Installing build tools (Homebrew)"
for formula in cmake ninja pkgconf protobuf json-c miniupnpc libevent opus openssl@3 python@3.13; do
  brew list --versions "$formula" >/dev/null 2>&1 || HOMEBREW_NO_AUTO_UPDATE=1 brew install "$formula"
done

echo "==> Fetching chiaki-ng $CHIAKI_TAG"
if [ ! -d vendor/chiaki-ng/.git ]; then
  mkdir -p vendor
  git clone --depth 1 --branch "$CHIAKI_TAG" https://github.com/chiaki-ng/chiaki-ng.git vendor/chiaki-ng
elif [ "$(git -C vendor/chiaki-ng describe --tags --exact-match 2>/dev/null || true)" != "$CHIAKI_TAG" ]; then
  # CHIAKI_TAG was changed since the last run: move the checkout to it. This
  # also drops the patches below, which are then applied afresh.
  git -C vendor/chiaki-ng fetch --depth 1 origin tag "$CHIAKI_TAG"
  git -C vendor/chiaki-ng checkout --force "$CHIAKI_TAG"
  rm -rf .build/helper
fi
git -C vendor/chiaki-ng submodule update --init --depth 1 \
  third-party/nanopb third-party/jerasure third-party/gf-complete third-party/curl
# Recent PS5 firmware can take longer than chiaki-ng's 3 seconds to answer a
# link request; the console then shows CE-110024-8. Give it 12 seconds.
if grep -q '^#define REGIST_REPONSE_TIMEOUT_MS 3000$' vendor/chiaki-ng/lib/src/regist.c; then
  sed -i '' 's/^#define REGIST_REPONSE_TIMEOUT_MS 3000$/#define REGIST_REPONSE_TIMEOUT_MS 12000/' \
    vendor/chiaki-ng/lib/src/regist.c
fi
grep -q '^#define REGIST_REPONSE_TIMEOUT_MS 12000$' vendor/chiaki-ng/lib/src/regist.c \
  || echo "warning: could not lengthen the linking timeout (chiaki-ng changed); linking may need a few tries." >&2
# The stream connection gives the console 5 seconds to answer, but Takion only
# resends its first packet after 5 seconds; a console that ignores the first
# one never gets to answer. Wait for all three tries (only the first match:
# the connect wait).
if ! grep -q 'ps5-vision: Takion resends' vendor/chiaki-ng/lib/src/streamconnection.c; then
  perl -0pi -e 's/(\terr = chiaki_cond_timedwait_pred\(&stream_connection->state_cond, &stream_connection->state_mutex, )EXPECT_TIMEOUT_MS(, state_finished_cond_check, stream_connection\);\n\tassert\(err == CHIAKI_ERR_SUCCESS \|\| err == CHIAKI_ERR_TIMEOUT\);\n\tCHECK_STOP\(close_takion\);)/\t\/\/ ps5-vision: Takion resends its init every 5 s; wait for all tries.\n${1}16000${2}/' \
    vendor/chiaki-ng/lib/src/streamconnection.c
fi
grep -q 'ps5-vision: Takion resends' vendor/chiaki-ng/lib/src/streamconnection.c \
  || echo "warning: could not lengthen the connect wait (chiaki-ng changed); connecting may fail the first time." >&2
# chiaki-ng lets the system hold about 100 KB of the stream for it: less than a
# tenth of a second of video. Whenever the Mac is busy for longer than that,
# the rest is thrown away and the picture freezes until the next keyframe.
# 2 MB rides out about a second. (What the console is told is left alone.)
if ! grep -q 'ps5-vision: receive buffer' vendor/chiaki-ng/lib/src/takion.c; then
  perl -pi -e 's|^(\t\tconst int rcvbuf_val = )takion->a_rwnd;$|${1}2 * 1024 * 1024; // ps5-vision: receive buffer|' \
    vendor/chiaki-ng/lib/src/takion.c
fi
grep -q 'ps5-vision: receive buffer' vendor/chiaki-ng/lib/src/takion.c \
  || echo "warning: could not enlarge the stream's receive buffer (chiaki-ng changed); the picture may freeze more often on a busy Mac." >&2
# Receiving the stream is as urgent as anything on screen: tell macOS, so
# other busy apps don't hold it up.
if ! grep -q 'ps5-vision: urgent threads' vendor/chiaki-ng/lib/src/thread.c; then
  perl -0pi -e 's|\tint r = pthread_create\(&thread->thread, NULL, func, arg\);|\t// ps5-vision: urgent threads\n\tpthread_attr_t attr;\n\tpthread_attr_init(&attr);\n#ifdef __APPLE__\n\tpthread_attr_set_qos_class_np(&attr, QOS_CLASS_USER_INTERACTIVE, 0);\n#endif\n\tint r = pthread_create(&thread->thread, &attr, func, arg);\n\tpthread_attr_destroy(&attr);|' \
    vendor/chiaki-ng/lib/src/thread.c
fi
grep -q 'ps5-vision: urgent threads' vendor/chiaki-ng/lib/src/thread.c \
  || echo "warning: could not raise the stream threads' priority (chiaki-ng changed)." >&2

echo "==> Preparing the protocol code generator"
# nanopb runs Homebrew's protoc, whose generated Python code only loads with
# the matching Python protobuf release (protoc 36.2 <-> protobuf x.36.2).
# Those releases need a newer Python than the one macOS ships.
PYTHON="$(brew --prefix python@3.13)/bin/python3.13"
if [ ! -x .build/venv/bin/python ] || ! .build/venv/bin/python -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  rm -rf .build/venv
  mkdir -p .build
  "$PYTHON" -m venv .build/venv
fi
PROTOC_VERSION="$(protoc --version | awk '{print $2}')"
INSTALLED_PROTOBUF="$(.build/venv/bin/python -c 'import google.protobuf as p; print(p.__version__)' 2>/dev/null || true)"
# Already matching (e.g. 7.36.2 for protoc 36.2)? Then there is nothing to
# look up, and a repeat run works offline.
if [ "${INSTALLED_PROTOBUF#*.}" != "$PROTOC_VERSION" ]; then
  PROTOBUF_VERSION="$(curl -fsSL https://pypi.org/pypi/protobuf/json | .build/venv/bin/python -c '
import json, sys
want = sys.argv[1]
versions = [v for v in json.load(sys.stdin)["releases"] if v.split(".", 1)[-1] == want]
print(max(versions, key=lambda v: int(v.split(".")[0])) if versions else "")
' "$PROTOC_VERSION")"
  if [ -z "$PROTOBUF_VERSION" ]; then
    echo "No Python protobuf release matches protoc $PROTOC_VERSION." >&2
    exit 1
  fi
  .build/venv/bin/python -m pip -q install "protobuf==$PROTOBUF_VERSION"
fi
# A copy generated by a mismatched protoc earlier would fail to load.
rm -f vendor/chiaki-ng/third-party/nanopb/generator/proto/nanopb_pb2.py

echo "==> Building the PS5 helper"
# A build folder remembers where the project was; start over if it has moved.
if [ -f .build/helper/CMakeCache.txt ] && ! grep -q "^CMAKE_HOME_DIRECTORY:INTERNAL=$ROOT/helper\$" .build/helper/CMakeCache.txt; then
  rm -rf .build/helper
fi
cmake -S helper -B .build/helper -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DPYTHON_EXECUTABLE="$ROOT/.build/venv/bin/python" \
  -DOPENSSL_ROOT_DIR="$(brew --prefix openssl@3)"
cmake --build .build/helper --target ps5-helper

echo "==> Installing the bridge's dependencies"
npm install --no-fund --no-audit

echo
echo "Done. Next: npm run link"
