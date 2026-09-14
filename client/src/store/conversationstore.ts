import { create } from "zustand";
import { ConversationType, MessageType, Model } from "../lib/types";
import { apiFetch, SERVER_ENDPOINTS } from "../lib/api";
import toast from "react-hot-toast";

function upsertAssistantMessage(
  messages: MessageType[] | null | undefined,
  conversationId: string,
  messageId: string,
  patch: Partial<MessageType>
): MessageType[] {
  const list = messages || [];
  const idx = list.findIndex((msg) => msg.ID === messageId);
  if (idx >= 0) {
    return list.map((msg, i) => (i === idx ? { ...msg, ...patch } : msg));
  }
  return [
    ...list,
    {
      ID: messageId,
      ConversationID: conversationId,
      Role: "assistant",
      Content: patch.Content ?? "",
      RawContent: patch.RawContent ?? patch.Content ?? "",
      Thinking: patch.Thinking ?? null,
      ThinkingTime: patch.ThinkingTime ?? null,
      CreatedAt: patch.CreatedAt ?? new Date().toISOString(),
    },
  ];
}

interface ConversationStore {
  // State
  conversations: ConversationType[];
  selectedConversation: ConversationType | null;
  messages: Record<string, MessageType[]>;
  models: Model[];
  selectedModel: Model | null;
  isInitialLoading: boolean;
  isMessagesLoading: boolean;
  error: string | null;

  // Actions
  fetchInitialData: () => Promise<void>;
  getConversation: (id: string) => Promise<void>;
  addMessageToConversation: (
    conversationId: string,
    message: MessageType
  ) => void;
  createNewConversation: (
    conversationId: string,
    model: string,
    firstMessage: MessageType
  ) => void;
  updateConversationTitle: (conversationId: string, title: string) => void;
  updateMessageContent: (
    conversationId: string,
    messageId: string,
    content: string
  ) => void;
  updateMessageWithThinking: (
    conversationId: string,
    messageId: string,
    content: string,
    thinking: string | null,
    thinkingTime: number | null
  ) => void;
  setSelectedConversation: (conversation: ConversationType | null) => void;
  setSelectedModel: (model: Model | null) => void;
  deleteConversation: (id: string) => Promise<void>;
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  conversations: [],
  selectedConversation: null,
  messages: {},
  models: [],
  selectedModel: null,
  isInitialLoading: false,
  isMessagesLoading: false,
  error: null,

  fetchInitialData: async () => {
    if (get().isInitialLoading) return;
    set({ isInitialLoading: true, error: null });
    try {
      console.log("Initial data fetching");

      // Conversations are SQLite-backed and must succeed for the app shell.
      let conversations;
      try {
        conversations = await apiFetch(SERVER_ENDPOINTS.conversatios);
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch conversations",
          isInitialLoading: false,
        });
        return;
      }

      // Models depend on Ollama — failure must not blank history browsing.
      let models: Model[] = [];
      try {
        const modelsResult = await apiFetch(SERVER_ENDPOINTS.models);
        models = Array.isArray(modelsResult) ? modelsResult : [];
      } catch {
        models = [];
        toast.error(
          "Could not load models (Ollama may be offline). Past chats still work."
        );
      }

      set({
        conversations,
        models,
        selectedModel: models[0] || get().selectedModel || null,
        isInitialLoading: false,
        error: null,
      });
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch initial data",
        isInitialLoading: false,
      });
    }
  },

  getConversation: async (id: string) => {
    console.log("GOT ID in STORE", id);

    try {
      const state = get();

      // Already showing this conversation (including an in-flight stream).
      if (state.selectedConversation?.ID === id && state.selectedConversation.Messages) {
        set({ isMessagesLoading: false, error: null });
        return;
      }

      const existingConversation = state.conversations.find(
        (conv) => conv.ID === id
      );

      if (existingConversation && state.messages[id]) {
        set({
          selectedConversation: {
            ...existingConversation,
            Messages: state.messages[id],
          },
          isMessagesLoading: false,
          error: null,
        });
        return;
      }

      set({ isMessagesLoading: true, error: null });

      const conversationWithMessages: ConversationType = await apiFetch(
        `${SERVER_ENDPOINTS.conversatios}/${id}`
      );

      set((state) => ({
        selectedConversation: conversationWithMessages,
        messages: {
          ...state.messages,
          [id]: conversationWithMessages.Messages || [],
        },
        isMessagesLoading: false,
      }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to fetch conversation";
      const isNotFoundError = errorMessage.includes("not found");

      set({
        isMessagesLoading: false,
        selectedConversation: null,
        error: isNotFoundError ? null : errorMessage,
      });

      throw error;
    }
  },

  addMessageToConversation: (conversationId: string, message: MessageType) => {
    set((state) => {
      const existingConversation = state.conversations.find(
        (conv) => conv.ID === conversationId
      );

      if (!existingConversation) {
        console.error(`Conversation ${conversationId} not found`);
        return state;
      }

      const updateSelectedConversation =
        state.selectedConversation?.ID === conversationId
          ? {
              ...state.selectedConversation,
              Messages: [
                ...(state.selectedConversation.Messages || []),
                message,
              ],
            }
          : state.selectedConversation;

      const existingMessages = state.messages[conversationId] || [];
      const updatedMessages = {
        ...state.messages,
        [conversationId]: [...existingMessages, message],
      };

      const updatedConversations = state.conversations.map((conv) =>
        conv.ID === conversationId
          ? { ...conv, UpdatedAt: message.CreatedAt }
          : conv
      );

      return {
        messages: updatedMessages,
        selectedConversation: updateSelectedConversation,
        conversations: updatedConversations,
      };
    });
  },

  createNewConversation: (
    conversationId: string,
    model: string,
    firstMessage: MessageType
  ) => {
    set((state) => {
      const defaultTitle =
        firstMessage.Content.slice(0, 30) +
        (firstMessage.Content.length > 30 ? "..." : "");

      const newConversation: ConversationType = {
        ID: conversationId,
        Title: defaultTitle,
        Model: model,
        CreatedAt: firstMessage.CreatedAt,
        UpdatedAt: firstMessage.CreatedAt,
        Messages: [firstMessage],
      };

      const updatesConversations = [newConversation, ...state.conversations];

      return {
        conversations: updatesConversations,
        selectedConversation: newConversation,
        messages: {
          ...state.messages,
          [conversationId]: [firstMessage],
        },
      };
    });
  },

  updateConversationTitle: (conversationId: string, title: string) => {
    set((state) => {
      const updatedConversations = state.conversations.map((conv) =>
        conv.ID === conversationId ? { ...conv, Title: title } : conv
      );

      const updateSelectedConversation =
        state.selectedConversation?.ID === conversationId
          ? { ...state.selectedConversation, Title: title }
          : state.selectedConversation;

      return {
        conversations: updatedConversations,
        selectedConversation: updateSelectedConversation,
      };
    });
  },

  updateMessageContent: (
    conversationId: string,
    messageId: string,
    content: string
  ) => {
    set((state) => {
      const patch = { Content: content, RawContent: content };
      const updatedCachedMessages = upsertAssistantMessage(
        state.messages[conversationId],
        conversationId,
        messageId,
        patch
      );

      const selectedIsThis = state.selectedConversation?.ID === conversationId;
      const updatedSelectedMessages = selectedIsThis
        ? upsertAssistantMessage(
            state.selectedConversation?.Messages,
            conversationId,
            messageId,
            patch
          )
        : state.selectedConversation?.Messages;

      return {
        selectedConversation: selectedIsThis
          ? {
              ...state.selectedConversation!,
              Messages: updatedSelectedMessages || [],
              UpdatedAt: new Date().toISOString(),
            }
          : state.selectedConversation,
        messages: {
          ...state.messages,
          [conversationId]: updatedCachedMessages,
        },
        conversations: state.conversations.map((conv) =>
          conv.ID === conversationId
            ? { ...conv, UpdatedAt: new Date().toISOString() }
            : conv
        ),
      };
    });
  },

  // Update a message with final content and thinking information
  updateMessageWithThinking: (
    conversationId: string,
    messageId: string,
    content: string,
    thinking: string | null,
    thinkingTime: number | null
  ) => {
    set((state) => {
      const patch = {
        Content: content,
        RawContent: content,
        Thinking: thinking || null,
        ThinkingTime: thinkingTime,
      };
      const updatedCachedMessages = upsertAssistantMessage(
        state.messages[conversationId],
        conversationId,
        messageId,
        patch
      );

      const selectedIsThis = state.selectedConversation?.ID === conversationId;
      const updatedSelectedMessages = selectedIsThis
        ? upsertAssistantMessage(
            state.selectedConversation?.Messages,
            conversationId,
            messageId,
            patch
          )
        : state.selectedConversation?.Messages;

      return {
        selectedConversation: selectedIsThis
          ? {
              ...state.selectedConversation!,
              Messages: updatedSelectedMessages || [],
              UpdatedAt: new Date().toISOString(),
            }
          : state.selectedConversation,
        messages: {
          ...state.messages,
          [conversationId]: updatedCachedMessages,
        },
        conversations: state.conversations.map((conv) =>
          conv.ID === conversationId
            ? { ...conv, UpdatedAt: new Date().toISOString() }
            : conv
        ),
      };
    });
  },
  deleteConversation: async (id: string) => {
    set({ error: null });

    try {
      await apiFetch(`${SERVER_ENDPOINTS.conversatios}/${id}`, {
        method: "DELETE",
      });

      set((state) => ({
        conversations: state.conversations.filter((conv) => conv.ID !== id),
        messages: Object.fromEntries(
          Object.entries(state.messages).filter(([key]) => key !== id)
        ),

        selectedConversation:
          state.selectedConversation?.ID === id
            ? null
            : state.selectedConversation,
      }));
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete conversation",
      });
      throw error;
    }
  },

  setSelectedConversation: (conversation) => {
    set({ selectedConversation: conversation });
  },

  setSelectedModel: (model) => {
    set({ selectedModel: model });
  },
}));
