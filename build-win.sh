#!/bin/bash
set -e

echo "Building Tiny Ollama Chat for Windows amd64 (AgentSandbox debug)..."

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [ -d "build-win" ]; then
  rm -rf build-win/*
else
  mkdir -p build-win
fi

echo "Building client..."
cd client
npm install
npm run build
cd ..

echo "Copying client build to build-win/static..."
mkdir -p build-win/static
cp -r client/dist/* build-win/static/

echo "Cross-compiling server for windows/amd64..."
cd server
go mod download
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ../build-win/tiny-ollama-chat.exe ./cmd/server/main.go
cd ..

cat > build-win/README-SANDBOX.txt << 'TXT'
Tiny Ollama Chat — Windows amd64 (AgentSandbox)

1. Put Ollama URL on the LAN, e.g.:
   tiny-ollama-chat.exe -ollama-url=http://192.168.x.x:11434

2. Open http://127.0.0.1:8080 (or the port the app prints)

3. DevTools → Network → WS: confirm thinking_chunk / response_chunk / done
   and that follow-up messages include convo_id.

static/ must sit next to the .exe (same layout as Pi).
TXT

echo "Windows build complete: build-win/tiny-ollama-chat.exe"
ls -lh build-win/tiny-ollama-chat.exe build-win/static | head
