# Tiny Ollama Chat — fixes applied 2026-09-15 (JST / Asia/Tokyo)

## v0.1.8-pi2 — unlock stuck `isGenerating` after answer completes

### Symptom (after v0.1.7 “ideal” retest)
- Answer text complete in UI (plain live preview), but toast/lock stays “Generating… please wait until it finishes”
- No Markdown render (still treated as streaming); browser refresh → Markdown + unlocked
- Server: think→response→done→DB save OK; WS coalesce flush OK; poll did not recover

### Root cause
- `response_done` called `stopPollFallback()` **before** store commits, then if commit threw (or done was missed), `isGenerating` stayed true with poll already dead — no HTTP recovery path.

### Fix
1. **`settleGenerating(reason)`** always: clearGeneratingTimeout, stopPollFallback, setIsThinking(false), markGenerating(false), clear live refs/previews, setConversationStreaming(false), navigateWhenReady.
2. **`response_done` / `error`**: try/catch around store commits; **`settleGenerating` in `finally`**. Do **not** stop poll at the start of `response_done`.
3. **Poll stays alive** until generating is false; interval **~600ms**.
4. **Idle auto-settle**: while generating, if live response/thinking is non-empty and has not grown for **~1.2s**, HTTP GET conversation + `applyRemoteAssistantAndSettle` (force unlock if HTTP keeps failing after longer idle).
5. **ChatView**: if `isGenerating` with non-empty `currentResponse` stable **>3s**, force `settleGenerating` + `reloadConversationMessages` (then store Message renders Markdown).
6. **Server**: if WriteJSON done-with-content fails, retry done with **empty content** so client unlocks.

## v0.1.7-pi2 — HTTP poll fallback + fewer WS frames (AgentSandbox Edge)

### Symptom (still on v0.1.6)
- Server finishes start→think→done→DB save in ~3s; raw WS on Pi2 localhost delivers all frames.
- AgentSandbox Edge still shows no live update until full page reload.
- Served JS was `index-KvOQePwr.js` from `~/tiny-ollama-chat-v016`.

### Fix
1. **Client poll safety net** (`WebSocketProvider`): while `isGenerating`, every ~1.5s `GET /api/conversations/:activeConvoId`. If remote has an assistant with non-empty Content/Thinking, merge into Zustand, clear thinking/generating/streaming/live refs (same outcome as manual refresh). Stop on done/error/unmount.
2. **Never skeleton over live UI** (`ChatView`): render `MessageSkeleton` only when `isMessagesLoading && !isGenerating`. Hard-skip `getConversation` while `isGeneratingRef` / streaming (do not await it).
3. **Defer `navigate(/chat/:id)`** until first `response_chunk` or `response_done` (or poll settle). New Chat `/` shows live Generating/Thinking/answer while generating even without route id.
4. **Server WS coalesce** (`handler.go` `appendThinking`/`appendContent`): buffer pieces and flush ≤ every 50ms (force on `thinking_end` / before done). Log flush counts once per generation.

## v0.1.6-pi2 — client fetch race + stream update thrash (AgentSandbox Edge)

### Symptom
- AgentSandbox Edge (even InPrivate): UI stuck on **Thinking** until full refresh.
- Raw WS from localhost shows full stream (`conversation_started` → `thinking_*` → `response_chunk*` → `done` with content).
- Refresh shows the saved answer → **server OK**; remaining bug is client/UI under AgentSandbox→Pi2 latency.

### Root cause
1. **Fetch race**: On `conversation_started`, client `navigate(/chat/:id)` then ChatView `useEffect([id])` calls `getConversation(id)`. Under latency that HTTP can return **after** WS `done` committed the assistant into Zustand and **overwrite** `selectedConversation` with a stale/partial payload (or set `isMessagesLoading` and hide live Thinking/answer behind skeletons).
2. **Update thrash**: Hundreds of `thinking_chunk` / `response_chunk` events each calling Zustand `updateMessageContent` starve paints on a slow VM, so live `currentResponse` never appears and the UI stays on Thinking.

### Fix
1. **ChatView / store**: Skip cold `getConversation` when mid-generate (`isGenerating` + matching id), when `streamingConversationIds[id]`, or when the store already has that conversation (e.g. just `createNewConversation`). In-flight HTTP results are ignored if `streamLocalVersion` advanced or streaming is active; reload keeps local assistant if remote is missing it.
2. **WebSocketProvider**: During stream, live UI stays on **refs + rAF previews** only — **no** `updateMessageContent` on every `response_chunk`. Commit to store on `response_done` (placeholder still created on `thinking_end` / first chunk). Clear `streamingConversationIds` after done/error/disconnect.
3. Keep `done.Content` fallback + `reloadConversationMessages` after done.
4. `thinking_end` / `response_done` / answer chunks **always** clear `isThinking` even if content is empty.

## v0.1.5-pi2 — live-UI blank after generate (AgentSandbox Edge)

### Symptom
- AgentSandbox Edge: generate finishes server-side, but UI stays blank until a full refresh.

### Cause
- `ChatView` hid the Zustand store assistant while `isGenerating`, relying only on live `currentResponse`.
- On `response_done`, live state was cleared without a reliable commit/refetch of the final answer.
- Fast think → answer → done races could clear `currentResponse` before the first paint / store upsert.

### Fix
- Server `done` frame carries final answer in `Content` (last-resort commit payload).
- Client commits refs / `done.Content` into the store **before** clearing live state.
- HTTP reload of conversation messages after `done` (safety net).
- `ChatView`: show store assistant when there is no live `currentResponse` (even while generating).
- First answer chunk flushes response preview immediately (same-tick done cannot blank the UI).

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
