#!/bin/sh
#
# Smoke-test the bundled llama.cpp server inside the action image.
#
# This is the only check that exercises the container's real purpose. Every
# other CI job runs the TypeScript bundle with `node` on the runner, so all of
# them would stay green even if llama-server could not start at all.
#
# Run it locally with:
#   docker build -t prsentinel-action .
#   docker run --rm -i --entrypoint /bin/sh prsentinel-action \
#     < scripts/verify-local-model.sh
#
# It fetches the 1 MB test model llama.cpp's own CI uses, so it stays cheap
# enough to run on every pull request.

set -e

node --version

# `ldd` exits 0 even when a dependency is missing, so its status proves nothing
# — read its output instead. An earlier image was missing libgomp.so.1, and this
# is what caught it.
libs=$(ldd /opt/llama/llama-server)
case "$libs" in
  *"not found"*)
    echo "llama-server has unresolved shared libraries:"
    echo "$libs"
    exit 1
    ;;
esac
echo "shared libraries resolved"

curl -fsSL -o /tmp/tiny.gguf \
  https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf

# Same flags src/llm/local.ts builds, so this exercises the real argv. The tiny
# model ships no chat template, hence the explicit one.
llama-server \
  --model /tmp/tiny.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 512 \
  --threads 2 \
  --parallel 1 \
  --chat-template chatml \
  --no-webui > /tmp/server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

# llama-server answers /health with 503 until the model is loaded, so a 2xx is
# the readiness signal our TypeScript bootstrap also polls for.
ready=0
for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:8080/health > /dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  echo "llama-server never became healthy. Server log:"
  cat /tmp/server.log
  exit 1
fi
echo "health endpoint is answering"

# Reaching /health already proves a compute backend loaded: without one the
# model never finishes loading. This goes further and speaks the exact OpenAI
# route src/llm/openai.ts uses.
resp=$(curl -fsS http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"tiny","messages":[{"role":"user","content":"Say ok."}],"max_tokens":8}')

echo "$resp"
echo "$resp" | grep -q '"choices"'
echo "$resp" | grep -q '"content"'

echo "local inference works"
