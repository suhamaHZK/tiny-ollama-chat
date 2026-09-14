#!/bin/sh
exec ./tiny-ollama-chat \
  -port="${PORT}" \
  -ollama-url="${OLLAMA_URL}" \
  -db-path="${DB_PATH}"