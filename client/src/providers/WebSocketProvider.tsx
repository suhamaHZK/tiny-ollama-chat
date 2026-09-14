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
});

export const useWebSocket = () => useContext(WebSocketContext);

interface WebSocketProviderProps {
  children: React.ReactNode;
}

/** Safety net if response_done/error never arrives (e.g. mid-stream disconnect). */
const GENERATING_SAFETY_MS = 45 * 1000;

const WebSocketProvider = ({ children }: WebSocketProviderProps) => {
  const navigate = useNavigate();
  const [isConnected, setIsConnected] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const generatingRef = useRef(false);
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
      markGenerating(false);
      setIsThinking(false);
      toast.error("Response timed out — you can send again");
    }, GENERATING_SAFETY_MS);
  }, [clearGeneratingTimeout, markGenerating]);

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

  // Internal reset only — not a way to force a second send while generating.
  const cancelGeneration = useCallback(() => {
    clearGeneratingTimeout();
    resetStreamState();
  }, [clearGeneratingTimeout, resetStreamState]);

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
      wsService.disconnect();
    };
  }, [fetchInitialData, clearGeneratingTimeout]);

  // Mount-once WS listeners — dispatch through handlersRef / local refs.
  useEffect(() => {
    const eventHandlers: Record<WSEventType, (data: any) => void> = {
      connected: () => {
        setIsConnected(true);
        toast.success("Connected to server");
      },
      disconnected: () => {
        setIsConnected(false);
        handlersRef.current.clearGeneratingTimeout();
        handlersRef.current.markGenerating(false);
        setIsThinking(false);
        toast.error("Disconnected from server");
      },
      thinking_start: () => {
        const h = handlersRef.current;
        h.markGenerating(true);
        setIsThinking(true);
        h.armGeneratingTimeout();
        currentThinkingRef.current = "";
        setCurrentThinking("");
        thinkingStartTimeRef.current = Date.now();
        thinkingEndTimeRef.current = null;
        setFinalThinking(null);
      },
      thinking_chunk: (content) => {
        if (content) {
          const h = handlersRef.current;
          h.markGenerating(true);
          h.armGeneratingTimeout();
          currentThinkingRef.current += content;
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
        setIsThinking(false);
        h.markGenerating(true);
        h.armGeneratingTimeout();

        // Create assistant placeholder before answer chunks arrive
        const convoId =
          activeConvoIdRef.current ||
          useConversationStore.getState().selectedConversation?.ID;
        if (convoId) {
          h.ensureAssistantPlaceholder(convoId);
        }
      },
      conversation_started: (conversationId) => {
        if (conversationId) {
          toast.success("New conversation started");
          activeConvoIdRef.current = conversationId;

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
          navigateRef.current(`/chat/${conversationId}`);
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
        setIsThinking(false);
        h.armGeneratingTimeout();
        currentResponseRef.current += content;

        // First answer token: hide live thinking panel (keep text in refs
        // for final updateMessageWithThinking).
        if (isFirstAnswerChunk) {
          h.clearThinkingPreviewTimer();
          setCurrentThinking("");
        }

        const convoId =
          activeConvoIdRef.current ||
          useConversationStore.getState().selectedConversation?.ID;

        if (convoId) {
          const messageId = h.ensureAssistantPlaceholder(convoId);
          useConversationStore
            .getState()
            .updateMessageContent(
              convoId,
              messageId,
              currentResponseRef.current
            );
        }

        // Live answer preview: rAF-coalesce at most 1 frame (never wait for done).
        h.scheduleResponsePreview();
      },
      response_done: () => {
        const h = handlersRef.current;
        h.flushThinkingPreview();
        h.flushResponsePreview();
        h.clearGeneratingTimeout();

        const responseText = currentResponseRef.current;
        const thinkingText = currentThinkingRef.current || null;
        const convoId =
          activeConvoIdRef.current ||
          useConversationStore.getState().selectedConversation?.ID;
        const activeMessageId = activeMessageIdRef.current;

        const thinkingTimeInSeconds = thinkingStartTimeRef.current
          ? ((thinkingEndTimeRef.current || Date.now()) -
              thinkingStartTimeRef.current) /
            1000
          : null;

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

        activeMessageIdRef.current = null;
        currentResponseRef.current = "";
        currentThinkingRef.current = "";
        thinkingStartTimeRef.current = null;
        thinkingEndTimeRef.current = null;
        setCurrentThinking("");
        setCurrentResponse("");
        setFinalThinking(null);
        setIsThinking(false);
        h.markGenerating(false);
      },
      error: (errorMsg) => {
        const h = handlersRef.current;
        console.error(`Error: ${errorMsg}`);
        h.flushThinkingPreview();
        h.flushResponsePreview();
        h.clearGeneratingTimeout();
        h.markGenerating(false);
        setIsThinking(false);
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

      const success = await wsService.sendMessage(
        selectedConversation.ID,
        message,
        selectedConversation.Model
      );

      if (!success) {
        clearGeneratingTimeout();
        markGenerating(false);
        toast.error("Failed to send message");
        return;
      }
    },
    [resetStreamState, armGeneratingTimeout, clearGeneratingTimeout, markGenerating]
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
      resetStreamState();
      markGenerating(true);
      armGeneratingTimeout();

      const success = await wsService.startConversation(model, message);

      if (!success) {
        clearGeneratingTimeout();
        markGenerating(false);
        toast.error("Failed to start conversation");
      }
    },
    [resetStreamState, armGeneratingTimeout, clearGeneratingTimeout, markGenerating]
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
