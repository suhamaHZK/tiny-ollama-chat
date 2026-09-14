# Tiny Ollama Chat — fixes applied 2026-09-14 (JST / Asia/Tokyo)

## v0.1.4-pi2 — `/api/show` Think capability detection

### Think detection (server)
- Primary: `POST /api/show` → if `capabilities` contains `thinking` (case-insensitive), send think
- `gpt-oss*`: value `"medium"` when thinking is supported
- Other thinking models: `think: true`
- Per-`Client` cache of resolved think params
- On show network/HTTP/decode error: fall back to name heuristics in `ThinkParam` (still used for e4b omit / qwen3 / gemma4 / etc.)
- Keep `ChatStreamNoThink` + `IsThinkUnsupported` retry when Ollama rejects thinking
- Client streaming behavior unchanged from v0.1.3

## v0.1.3-pi2 — visible answer-body streaming (client)

### Root cause
- Thinking used live `currentThinking` preview state (smooth).
- Answer relied on Zustand `Message` updates that React can batch into one paint; ChatView only showed `currentResponse` when the store had no assistant text yet — once the placeholder existed, the live preview path was unused.
- After `thinking_end`, `currentThinking` stayed truthy until `done`, competing with the answer area.

### 1) `WebSocketProvider.tsx`
- Each `response_chunk` updates `currentResponseRef` and schedules `setCurrentResponse` via **rAF** (≤1 frame; never waits for `done`).
- On **first** `response_chunk`: clear live thinking preview (`setCurrentThinking("")`) while keeping thinking text in refs for final `updateMessageWithThinking`.
- Store `updateMessageContent` still runs each chunk.
- WS handlers registered **once on mount** via `handlersRef` (no mid-stream re-subscribe).

### 2) `ChatView.tsx`
- While `isGenerating`, always show a dedicated live answer block bound to `currentResponse` (plain text).
- Hide the in-flight store assistant placeholder during generation (live block is source of truth).
- Hide thinking preview once `currentResponse` is non-empty (or after first answer chunk clears it).

### 3) `Message.tsx`
- Kept `isStreaming` plain-text path for finished/non-live renders.

### 4) ThinkParam (`server/internal/ollama/think.go`)
- Enable `think:true` for the **gemma4** family (including `gemma4:e2b`), still omit for **e4b** completion-only.

## v0.1.2-pi2 — think omit + single-flight + live answer

### 1) Think param (`server/internal/ollama/think.go`, `client.go`)
- `ThinkParam` no longer sends `think:true` for every model
- Default: **omit** the `think` field (unknown / completion-only)
- Enable: `gpt-oss` → `"medium"`; `qwen3` / `qwen3.8` / `deepseek-r1` / `r1` variants → `true`; names containing `thinking`; Gemma 4 family (except e4b)
- Explicit disable: any name containing `e4b` (Gemma-4-E4B)
- `ChatRequest.Think` uses `omitempty`; `ChatStream(ctx, …)` only sets think when `ThinkParam` says so
- If Ollama returns “does not support thinking”, `generateResponse` retries once via `ChatStreamNoThink`

### 2) Single-flight generation (`server/internal/ws/handler.go`)
- `Client` has `genMu`, `generating`, `genCancel`, `connCtx`
- Second `start_conversation` / `message` while a reply is in flight is **rejected** with “Please wait for the current reply to finish”
- `ChatStream` takes `context.Context` so disconnect/cancel aborts the HTTP body read
- `generateResponse` always `endGeneration()` + `done`

### 3) Store (`conversationstore.ts`)
- `addMessageToConversation` uses `state.messages[id] || []` (never `null` spread)
- `updateMessageContent` / `updateMessageWithThinking` **upsert** an assistant message if the id is missing so streamed tokens are not dropped

### 4) ChatInput
- Removed `cancelGeneration()`-before-send (that caused dual `generateResponse`)
- Send disabled while `isGenerating`; status: “Generating… please wait until it finishes”
- `isSubmitting` guard kept

### 5) Live answer preview
- Last assistant message while `isGenerating` renders **plain text** (`whitespace-pre-wrap`), Markdown only after done
- `currentResponse` still shown as a fallback if the store does not yet have assistant text
- `cancelGeneration` is internal reset only — not advertised as a force-send

## v0.1.1-pi2 — send unlock + live streaming

### A) Send button stuck (`isGenerating` / `isThinking`)
- `response_done` / `error` / `disconnected` always clear generating flags
- Removed React `StrictMode` from `client/src/main.tsx`
- Safety timeout **45s**

### B) Streaming into message list
- On first answer chunk (or `thinking_end`), create assistant placeholder in store
- Each `response_chunk` calls `updateMessageContent` with accumulated text

### C) Server (`handler.go`)
- `generateResponse` runs in a goroutine; per-client write mutex
- NDJSON via `json.NewDecoder`; always send `done`

### Prior (v0.1.0-pi2)
- Offline past-log browsing when Ollama is down
- `handleMessage` prefers client `convo_id` after WS reconnect
- `ChatView` re-sends `resume_conversation` after disconnect

## Build
- `./build-win.sh` → `build-win/tiny-ollama-chat.exe` + `build-win/static/`
- `./build-pi.sh` → `linux/arm GOARM=7` `CGO_ENABLED=0`
- Output: `build-pi/tiny-ollama-chat`, `build-pi/static/`, release assets `tiny-ollama-chat.xz`, `static-pi2.tar.gz`
