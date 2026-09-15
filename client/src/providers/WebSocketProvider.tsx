import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useConversationStore } from "../store/conversationstore";
import wsService, { WSEventType } from "../service/ws";
import toast from "react-hot-toast";
import { MessageType } from "../lib/types";
import { apiFetch, SERVER_ENDPOINTS } from "../lib/api";
import { useNavigate } from "react-router-dom";

interface WebSocketContextType {
  isConnected: boolean;
  isThinking: boolean;
  isGenerating: boolean;
  currentThinking: string;
  currentResponse: string;
  finalThinking: string | null;
  sendMessage: (message: string) => Promise<void>;
  startConversation: (model: string, message: string) => Promise<void>;
  resumeConversation: (conversationId: string) => Promise<void>;
  clearThinkingState: () => void;
  cancelGeneration: () => void;
  /** Always unlock Generating UI (poll/WS/idle/ChatView). */
  settleGenerating: (reason?: string) => void;
}

const WebSocketContext = createContext<WebSocketContextType>({
  isConnected: false,
  isThinking: false,
  isGenerating: false,
  currentThinking: "",
  currentResponse: "",
  finalThinking: null,
  sendMessage: async () => {},
  startConversation: async () => {},
  resumeConversation: async () => {},
  clearThinkingState: () => {},
  cancelGeneration: () => {},
  settleGenerating: () => {},
});

export const useWebSocket = () => useContext(WebSocketContext);

interface WebSocketProviderProps {
  children: React.ReactNode;
}

/** Safety net if response_done/error never arrives (e.g. mid-stream disconnect). */
const GENERATING_SAFETY_MS = 45 * 1000;
/** HTTP poll while generating — mirrors manual refresh if WS live UI stalls. */
const POLL_FALLBACK_MS = 600;
/** If live preview text stops growing for this long, force HTTP settle. */
const IDLE_SETTLE_MS = 1200;

const WebSocketProvider = ({ children }: WebSocketProviderProps) => {
  const navigate = useNavigate();
  const [isConnected, setIsConnected] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const generatingRef = useRef(false);
  const settleGeneratingRef = useRef<(reason?: string) => void>(() => {});
  const markGenerating = useCallback((value: boolean) => {
    generatingRef.current = value;
    setIsGenerating(value);
  }, []);
  const [finalThinking, setFinalThinking] = useState<string | null>(null);
  const [currentThinking, setCurrentThinking] = useState("");
  const [currentResponse, setCurrentResponse] = useState("");

  const currentUserMessageRef = useRef<string>("");
  const currentResponseRef = useRef<string>("");
  const currentThinkingRef = useRef<string>("");
  const activeConvoIdRef = useRef<string | null>(null);
  const activeMessageIdRef = useRef<string | null>(null);
  const thinkingStartTimeRef = useRef<number | null>(null);
  const thinkingEndTimeRef = useRef<number | null>(null);
  const thinkingPreviewTimerRef = useRef<number | null>(null);
  const responseRafRef = useRef<number | null>(null);
  const generatingTimeoutRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const lastStreamLenRef = useRef(0);
  const lastStreamChangeAtRef = useRef(0);
  const idleSettleInFlightRef = useRef(false);
  /** Defer /chat/:id navigate until first chunk or done (avoids id-effect races). */
  const pendingNavigateIdRef = useRef<string | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const { fetchInitialData, error } = useConversationStore();

  const clearGeneratingTimeout = useCallback(() => {
    if (generatingTimeoutRef.current != null) {
      window.clearTimeout(generatingTimeoutRef.current);
      generatingTimeoutRef.current = null;
    }
  }, []);

  const armGeneratingTimeout = useCallback(() => {
    clearGeneratingTimeout();
    generatingTimeoutRef.current = window.setTimeout(() => {
      generatingTimeoutRef.current = null;
      console.warn("isGenerating safety timeout — clearing stuck send state");
      settleGeneratingRef.current("safety-timeout");
      toast.error("Response timed out — you can send again");
    }, GENERATING_SAFETY_MS);
  }, [clearGeneratingTimeout]);

  const clearThinkingPreviewTimer = useCallback(() => {
    if (thinkingPreviewTimerRef.current != null) {
      window.clearTimeout(thinkingPreviewTimerRef.current);
      thinkingPreviewTimerRef.current = null;
    }
  }, []);

  const clearResponseRaf = useCallback(() => {
    if (responseRafRef.current != null) {
      window.cancelAnimationFrame(responseRafRef.current);
      responseRafRef.current = null;
    }
  }, []);

  const flushThinkingPreview = useCallback(() => {
    clearThinkingPreviewTimer();
    setCurrentThinking(currentThinkingRef.current);
  }, [clearThinkingPreviewTimer]);

  const scheduleThinkingPreview = useCallback(() => {
    if (thinkingPreviewTimerRef.current != null) {
      return;
    }
    thinkingPreviewTimerRef.current = window.setTimeout(() => {
      thinkingPreviewTimerRef.current = null;
      setCurrentThinking(currentThinkingRef.current);
    }, 32);
  }, []);

  /** Push answer preview at most once per animation frame (never wait for done). */
  const scheduleResponsePreview = useCallback(() => {
    if (responseRafRef.current != null) {
      return;
    }
    responseRafRef.current = window.requestAnimationFrame(() => {
      responseRafRef.current = null;
      setCurrentResponse(currentResponseRef.current);
    });
  }, []);

  const flushResponsePreview = useCallback(() => {
    clearResponseRaf();
    setCurrentResponse(currentResponseRef.current);
  }, [clearResponseRaf]);

  const resetStreamState = useCallback(() => {
    clearThinkingPreviewTimer();
    clearResponseRaf();
    clearGeneratingTimeout();
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollInFlightRef.current = false;
    currentResponseRef.current = "";
    currentThinkingRef.current = "";
    activeMessageIdRef.current = null;
    thinkingStartTimeRef.current = null;
    thinkingEndTimeRef.current = null;
    setCurrentThinking("");
    setCurrentResponse("");
    setFinalThinking(null);
    setIsThinking(false);
    markGenerating(false);
  }, [
    clearThinkingPreviewTimer,
    clearResponseRaf,
    clearGeneratingTimeout,
    markGenerating,
  ]);

  const stopPollFallback = useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollInFlightRef.current = false;
    idleSettleInFlightRef.current = false;
  }, []);

  const navigateWhenReady = useCallback((conversationId?: string | null) => {
    const id = conversationId || pendingNavigateIdRef.current;
    if (!id) return;
    pendingNavigateIdRef.current = null;
    navigateRef.current(`/chat/${id}`);
  }, []);

  const noteStreamGrowth = useCallback(() => {
    const len =
      currentResponseRef.current.length + currentThinkingRef.current.length;
    if (len !== lastStreamLenRef.current) {
      lastStreamLenRef.current = len;
      lastStreamChangeAtRef.current = Date.now();
    }
  }, []);

  /** ALWAYS unlock generating UI — never leave isGenerating true. */
  const settleGenerating = useCallback(
    (reason?: string) => {
      if (reason) {
        console.log("settleGenerating:", reason);
      }
      clearThinkingPreviewTimer();
      clearResponseRaf();
      clearGeneratingTimeout();
      stopPollFallback();
      currentResponseRef.current = "";
      currentThinkingRef.current = "";
      activeMessageIdRef.current = null;
      thinkingStartTimeRef.current = null;
      thinkingEndTimeRef.current = null;
      lastStreamLenRef.current = 0;
      lastStreamChangeAtRef.current = 0;
      setCurrentThinking("");
      setCurrentResponse("");
      setFinalThinking(null);
      setIsThinking(false);
      markGenerating(false);
      const convoId =
        activeConvoIdRef.current ||
        useConversationStore.getState().selectedConversation?.ID;
      if (convoId) {
        useConversationStore.getState().setConversationStreaming(convoId, false);
      }
      navigateWhenReady(convoId);
    },
    [
      clearThinkingPreviewTimer,
      clearResponseRaf,
      clearGeneratingTimeout,
      stopPollFallback,
      markGenerating,
      navigateWhenReady,
    ]
  );
  settleGeneratingRef.current = settleGenerating;

  /** Merge remote assistant into store and clear live generating UI (same as refresh). */
  const applyRemoteAssistantAndSettle = useCallback(
    (
      convoId: string,
      remote: {
        ID?: string;
        Title?: string;
        Model?: string;
        Messages?: MessageType[];
      },
      reason = "poll-remote"
    ) => {
      const msgs = remote.Messages || [];
      const assistant = [...msgs]
        .reverse()
        .find(
          (m) =>
            m.Role === "assistant" &&
            Boolean(
              (m.Content && m.Content.trim()) ||
                (m.Thinking && String(m.Thinking).trim())
            )
        );
      if (!assistant) return false;

      try {
        const store = useConversationStore.getState();
        const existing =
          store.conversations.find((c) => c.ID === convoId) ||
          (store.selectedConversation?.ID === convoId
            ? store.selectedConversation
            : null);

        store.bumpStreamLocalVersion(convoId);

        const mergedMessages = msgs.length ? msgs : [assistant];

        useConversationStore.setState((state) => {
          const convMeta = {
            ID: convoId,
            Title: remote.Title || existing?.Title || "Chat",
            Model:
              remote.Model ||
              existing?.Model ||
              state.selectedModel?.model ||
              "Unknown Model",
            CreatedAt: (existing as any)?.CreatedAt || new Date().toISOString(),
            UpdatedAt: new Date().toISOString(),
          };
          const nextConversations = state.conversations.some(
            (c) => c.ID === convoId
          )
            ? state.conversations.map((c) =>
                c.ID === convoId ? { ...c, ...convMeta } : c
              )
            : [
                { ...convMeta, Messages: undefined as any },
                ...state.conversations,
              ];
          return {
            conversations: nextConversations,
            messages: { ...state.messages, [convoId]: mergedMessages },
            selectedConversation: {
              ...convMeta,
              Messages: mergedMessages,
            } as any,
            isMessagesLoading: false,
          };
        });
      } catch (err) {
        console.warn("applyRemoteAssistant store commit failed", err);
      } finally {
        settleGenerating(reason);
      }
      return true;
    },
    [settleGenerating]
  );

  const startPollFallback = useCallback(() => {
    stopPollFallback();
    lastStreamLenRef.current =
      currentResponseRef.current.length + currentThinkingRef.current.length;
    lastStreamChangeAtRef.current = Date.now();
    pollTimerRef.current = window.setInterval(() => {
      void (async () => {
        if (!generatingRef.current) {
          stopPollFallback();
          return;
        }

        const streamLen =
          currentResponseRef.current.length +
          currentThinkingRef.current.length;
        if (streamLen !== lastStreamLenRef.current) {
          lastStreamLenRef.current = streamLen;
          lastStreamChangeAtRef.current = Date.now();
        }

        const convoId = activeConvoIdRef.current;
        if (!convoId) {
          return;
        }
        if (pollInFlightRef.current || idleSettleInFlightRef.current) {
          return;
        }

        const idleMs = Date.now() - lastStreamChangeAtRef.current;
        const idleReady =
          streamLen > 0 && idleMs >= IDLE_SETTLE_MS;

        // Always keep polling while generating; idle path forces an immediate GET.
        if (!idleReady && idleMs < POLL_FALLBACK_MS) {
          // still allow regular interval polls below
        }

        pollInFlightRef.current = true;
        if (idleReady) {
          idleSettleInFlightRef.current = true;
        }
        try {
          const remote = await apiFetch(
            `${SERVER_ENDPOINTS.conversatios}/${convoId}`
          );
          if (!generatingRef.current) {
            return;
          }
          if (remote && applyRemoteAssistantAndSettle(convoId, remote, idleReady ? "idle-auto-settle" : "poll-remote")) {
            console.log(
              idleReady
                ? "idle auto-settle: remote assistant present — settled UI for"
                : "poll fallback: remote assistant present — settled UI for",
              convoId
            );
          }
        } catch (err) {
          console.warn("poll fallback error", err);
          // If live text is idle and HTTP fails repeatedly, still unlock after
          // a longer idle so the user is never permanently stuck.
          if (
            idleReady &&
            streamLen > 0 &&
            idleMs >= IDLE_SETTLE_MS * 3
          ) {
            settleGenerating("idle-force-unlock");
            void useConversationStore
              .getState()
              .reloadConversationMessages(convoId);
          }
        } finally {
          pollInFlightRef.current = false;
          idleSettleInFlightRef.current = false;
        }
      })();
    }, POLL_FALLBACK_MS);
  }, [
    stopPollFallback,
    applyRemoteAssistantAndSettle,
    settleGenerating,
  ]);

  // Internal reset only — not a way to force a second send while generating.
  const cancelGeneration = useCallback(() => {
    settleGenerating("cancelGeneration");
  }, [settleGenerating]);

  /** Ensure an assistant placeholder exists in the store for live streaming. */
  const ensureAssistantPlaceholder = useCallback((convoId: string) => {
    if (activeMessageIdRef.current) {
      return activeMessageIdRef.current;
    }
    const messageId = crypto.randomUUID();
    activeMessageIdRef.current = messageId;
    const placeholder: MessageType = {
      ID: messageId,
      ConversationID: convoId,
      Role: "assistant",
      Content: "",
      RawContent: "",
      Thinking: null,
      ThinkingTime: null,
      CreatedAt: new Date().toISOString(),
    };
    useConversationStore.getState().addMessageToConversation(convoId, placeholder);
    return messageId;
  }, []);

  // Keep latest helpers in a ref so WS listeners can be registered once.
  const handlersRef = useRef({
    markGenerating,
    armGeneratingTimeout,
    clearGeneratingTimeout,
    scheduleThinkingPreview,
    flushThinkingPreview,
    scheduleResponsePreview,
    flushResponsePreview,
    ensureAssistantPlaceholder,
    clearThinkingPreviewTimer,
    startPollFallback,
    stopPollFallback,
    navigateWhenReady,
    settleGenerating,
    noteStreamGrowth,
  });
  handlersRef.current = {
    markGenerating,
    armGeneratingTimeout,
    clearGeneratingTimeout,
    scheduleThinkingPreview,
    flushThinkingPreview,
    scheduleResponsePreview,
    flushResponsePreview,
    ensureAssistantPlaceholder,
    clearThinkingPreviewTimer,
    startPollFallback,
    stopPollFallback,
    navigateWhenReady,
    settleGenerating,
    noteStreamGrowth,
  };

  useEffect(() => {
    const initializeApp = async () => {
      await fetchInitialData();
      const connected = await wsService.connect();
      setIsConnected(connected);
    };

    initializeApp();

    return () => {
      clearGeneratingTimeout();
      stopPollFallback();
      wsService.disconnect();
    };
  }, [fetchInitialData, clearGeneratingTimeout, stopPollFallback]);

  // Mount-once WS listeners — dispatch through handlersRef / local refs.
  useEffect(() => {
    const eventHandlers: Record<WSEventType, (data: any) => void> = {
      connected: () => {
        setIsConnected(true);
        toast.success("Connected to server");
      },
      disconnected: () => {
        setIsConnected(false);
        handlersRef.current.settleGenerating("disconnected");
        const store = useConversationStore.getState();
        const streamingIds = Object.keys(store.streamingConversationIds);
        for (const sid of streamingIds) {
          store.setConversationStreaming(sid, false);
        }
        toast.error("Disconnected from server");
      },
      thinking_start: () => {
        const h = handlersRef.current;
        h.markGenerating(true);
        setIsThinking(true);
        h.armGeneratingTimeout();
        h.startPollFallback();
        currentThinkingRef.current = "";
        setCurrentThinking("");
        thinkingStartTimeRef.current = Date.now();
        thinkingEndTimeRef.current = null;
        setFinalThinking(null);
        const convoId =
          activeConvoIdRef.current ||
          useConversationStore.getState().selectedConversation?.ID;
        if (convoId) {
          useConversationStore.getState().setConversationStreaming(convoId, true);
        }
      },
      thinking_chunk: (content) => {
        if (content) {
          const h = handlersRef.current;
          h.markGenerating(true);
          h.armGeneratingTimeout();
          currentThinkingRef.current += content;
          h.noteStreamGrowth();
          h.scheduleThinkingPreview();
        }
      },
      thinking_end: (content) => {
        const h = handlersRef.current;
        const thinkingText =
          (typeof content === "string" && content) ||
          currentThinkingRef.current ||
          "";
        if (thinkingText) {
          currentThinkingRef.current = thinkingText;
          setCurrentThinking(thinkingText);
          setFinalThinking(thinkingText);
        }
        thinkingEndTimeRef.current = Date.now();
        // Always clear thinking flag even when content is empty.
        setIsThinking(false);
        h.markGenerating(true);
        h.armGeneratingTimeout();

        // Create assistant placeholder before answer chunks arrive
        // (do not thrash Zustand with per-chunk content — live UI uses refs).
        const convoId =
          activeConvoIdRef.current ||
          useConversationStore.getState().selectedConversation?.ID;
        if (convoId) {
          useConversationStore.getState().setConversationStreaming(convoId, true);
          h.ensureAssistantPlaceholder(convoId);
        }
      },
      conversation_started: (conversationId) => {
        if (conversationId) {
          toast.success("New conversation started");
          activeConvoIdRef.current = conversationId;
          // Defer route change until first response_chunk / response_done so
          // New Chat keeps showing live Generating/Thinking (no id-effect races).
          pendingNavigateIdRef.current = conversationId;

          const userMessage: MessageType = {
            ID: crypto.randomUUID(),
            ConversationID: conversationId,
            Role: "user",
            Content: currentUserMessageRef.current,
            RawContent: currentUserMessageRef.current,
            Thinking: null,
            ThinkingTime: null,
            CreatedAt: new Date().toISOString(),
          };

          const model =
            useConversationStore.getState().selectedModel?.model ||
            "Unknown Model";

          useConversationStore
            .getState()
            .createNewConversation(conversationId, model, userMessage);

          currentUserMessageRef.current = "";
          handlersRef.current.startPollFallback();
        }
      },
      conversation_resumed: (conversationId) => {
        if (conversationId) {
          console.log(`Successfully resumed conversation: ${conversationId}`);
          toast.success(`Resumed conversation`);
        } else {
          console.warn(
            "Received conversation_resumed event without conversation ID"
          );
        }
      },
      response_chunk: (content) => {
        if (!content) {
          return;
        }
        const h = handlersRef.current;
        const isFirstAnswerChunk = currentResponseRef.current.length === 0;

        h.markGenerating(true);
        // Always clear thinking once answer tokens arrive.
        setIsThinking(false);
        h.armGeneratingTimeout();
        currentResponseRef.current += content;
        h.noteStreamGrowth();

        // First answer token: hide live thinking panel (keep text in refs
        // for final updateMessageWithThinking) and paint immediately so a
        // same-tick done burst cannot clear currentResponse before first paint.
        if (isFirstAnswerChunk) {
          h.clearThinkingPreviewTimer();
          setCurrentThinking("");
          h.flushResponsePreview();
          h.navigateWhenReady();
        } else {
          // Live answer preview: rAF-coalesce at most 1 frame.
          // Do NOT call updateMessageContent here — per-chunk Zustand writes
          // starve paints under AgentSandbox→Pi2 latency.
          h.scheduleResponsePreview();
        }

        const convoId =
          activeConvoIdRef.current ||
          useConversationStore.getState().selectedConversation?.ID;

        if (convoId) {
          useConversationStore.getState().setConversationStreaming(convoId, true);
          // Placeholder once; content committed on response_done only.
          h.ensureAssistantPlaceholder(convoId);
        }
      },
      response_done: (doneContent) => {
        const h = handlersRef.current;
        // Do NOT stop poll here — keep it alive until settleGenerating so a
        // thrown store commit cannot strand isGenerating=true with poll dead.
        h.flushThinkingPreview();
        h.flushResponsePreview();

        let reloadId: string | null = null;
        try {
          // Prefer streamed accumulation; fall back to done.Content from server
          // (last-resort when response_chunk frames were missed / never painted).
          let responseText = currentResponseRef.current;
          if (
            !responseText &&
            typeof doneContent === "string" &&
            doneContent.length > 0
          ) {
            responseText = doneContent;
            currentResponseRef.current = doneContent;
            setCurrentResponse(doneContent);
          }
          const thinkingText = currentThinkingRef.current || null;
          const convoId =
            activeConvoIdRef.current ||
            useConversationStore.getState().selectedConversation?.ID;
          const activeMessageId = activeMessageIdRef.current;
          reloadId = convoId || null;

          const thinkingTimeInSeconds = thinkingStartTimeRef.current
            ? ((thinkingEndTimeRef.current || Date.now()) -
                thinkingStartTimeRef.current) /
              1000
            : null;

          // Commit assistant to the store BEFORE clearing live preview state so
          // ChatView never has a gap where isGenerating is false and the
          // assistant row is missing.
          if (convoId && (responseText || thinkingText)) {
            const store = useConversationStore.getState();

            if (activeMessageId) {
              store.updateMessageWithThinking(
                convoId,
                activeMessageId,
                responseText,
                thinkingText,
                thinkingTimeInSeconds
              );
            } else {
              const assistantMessage: MessageType = {
                ID: crypto.randomUUID(),
                ConversationID: convoId,
                Role: "assistant",
                Content: responseText,
                RawContent: responseText,
                Thinking: thinkingText,
                ThinkingTime: thinkingTimeInSeconds,
                CreatedAt: new Date().toISOString(),
              };

              const alreadyPresent = store.selectedConversation?.Messages?.some(
                (msg) =>
                  msg.Role === "assistant" &&
                  msg.Content === responseText &&
                  msg.Thinking === thinkingText
              );

              if (!alreadyPresent) {
                store.addMessageToConversation(convoId, assistantMessage);
              }
            }
          }
        } catch (err) {
          console.warn("response_done store commit failed", err);
        } finally {
          h.settleGenerating("response_done");
        }

        // Safety net: refetch persisted messages so UI matches DB even if
        // live store updates were dropped (client UUID vs server UUID, etc.).
        if (reloadId) {
          void useConversationStore
            .getState()
            .reloadConversationMessages(reloadId);
        }
      },
      error: (errorMsg) => {
        const h = handlersRef.current;
        console.error(`Error: ${errorMsg}`);
        h.flushThinkingPreview();
        h.flushResponsePreview();

        try {
          // If we already accumulated answer text, commit it before clearing
          // so a late error does not blank the turn.
          const responseText = currentResponseRef.current;
          const thinkingText = currentThinkingRef.current || null;
          const convoId =
            activeConvoIdRef.current ||
            useConversationStore.getState().selectedConversation?.ID;
          const activeMessageId = activeMessageIdRef.current;
          if (convoId && (responseText || thinkingText)) {
            const store = useConversationStore.getState();
            if (activeMessageId) {
              store.updateMessageWithThinking(
                convoId,
                activeMessageId,
                responseText,
                thinkingText,
                null
              );
            } else {
              store.addMessageToConversation(convoId, {
                ID: crypto.randomUUID(),
                ConversationID: convoId,
                Role: "assistant",
                Content: responseText,
                RawContent: responseText,
                Thinking: thinkingText,
                ThinkingTime: null,
                CreatedAt: new Date().toISOString(),
              });
            }
          }
        } catch (err) {
          console.warn("error handler store commit failed", err);
        } finally {
          h.settleGenerating("error");
        }
        if (typeof errorMsg === "string" && errorMsg) {
          toast.error(errorMsg);
        }
      },
    };

    Object.entries(eventHandlers).forEach(([event, handler]) => {
      wsService.addEventListener(event as WSEventType, handler);
    });

    return () => {
      Object.entries(eventHandlers).forEach(([event, handler]) => {
        wsService.removeEventListener(event as WSEventType, handler);
      });
    };
  }, []);

  const sendMessage = useCallback(
    async (message: string) => {
      if (generatingRef.current) {
        toast.error("Generating… please wait until it finishes");
        return;
      }

      const selectedConversation =
        useConversationStore.getState().selectedConversation;
      if (!selectedConversation) {
        toast.error("No active conversation");
        return;
      }

      const userMessage: MessageType = {
        ID: crypto.randomUUID(),
        ConversationID: selectedConversation.ID,
        Role: "user",
        Content: message,
        RawContent: message,
        Thinking: null,
        ThinkingTime: null,
        CreatedAt: new Date().toISOString(),
      };

      useConversationStore
        .getState()
        .addMessageToConversation(selectedConversation.ID, userMessage);

      activeConvoIdRef.current = selectedConversation.ID;
      resetStreamState();
      markGenerating(true);
      armGeneratingTimeout();
      startPollFallback();
      useConversationStore
        .getState()
        .setConversationStreaming(selectedConversation.ID, true);

      const success = await wsService.sendMessage(
        selectedConversation.ID,
        message,
        selectedConversation.Model
      );

      if (!success) {
        settleGenerating("send-failed");
        toast.error("Failed to send message");
        return;
      }
    },
    [resetStreamState, armGeneratingTimeout, markGenerating, startPollFallback, settleGenerating]
  );

  const startConversation = useCallback(
    async (model: string, message: string) => {
      if (generatingRef.current) {
        toast.error("Generating… please wait until it finishes");
        return;
      }

      if (!model) {
        toast.error("No model selected");
        return;
      }

      currentUserMessageRef.current = message;
      activeConvoIdRef.current = null;
      pendingNavigateIdRef.current = null;
      resetStreamState();
      markGenerating(true);
      armGeneratingTimeout();
      // Poll starts once conversation_started sets activeConvoId.

      const success = await wsService.startConversation(model, message);

      if (!success) {
        settleGenerating("start-failed");
        toast.error("Failed to start conversation");
      }
    },
    [resetStreamState, armGeneratingTimeout, markGenerating, settleGenerating]
  );

  const resumeConversation = useCallback(async (conversationId: string) => {
    console.log(`Resuming conversation: ${conversationId}`);
    const success = await wsService.resumeConversation(conversationId);

    if (!success) {
      toast.error("Failed to resume conversation");
    }
  }, []);

  const clearThinkingState = useCallback(() => {
    if (isGenerating || currentResponseRef.current || currentThinkingRef.current) {
      return;
    }
    resetStreamState();
  }, [isGenerating, resetStreamState]);

  const contextValue: WebSocketContextType = {
    isConnected,
    isThinking,
    isGenerating,
    currentThinking,
    currentResponse,
    finalThinking,
    sendMessage,
    startConversation,
    resumeConversation,
    clearThinkingState,
    cancelGeneration,
    settleGenerating,
  };

  // Soften: never blank the whole app for load errors (e.g. models offline).
  // Conversations-only failures still show a non-blocking banner.
  return (
    <WebSocketContext.Provider value={contextValue}>
      <div className="min-h-screen bg-gray-950">
        {error && (
          <div className="bg-red-950/80 border-b border-red-800 text-red-200 px-4 py-2 text-sm text-center">
            {error}
          </div>
        )}
        {children}
      </div>
    </WebSocketContext.Provider>
  );
};

export default WebSocketProvider;
