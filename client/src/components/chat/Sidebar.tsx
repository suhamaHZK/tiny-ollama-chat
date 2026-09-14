import { useNavigate } from "react-router-dom";
import ConversationItem from "./ConversationItem";
import { ChevronLeft, Plus } from "lucide-react";

import { useConversationStore } from "../../store/conversationstore";
import { ConversationSkeleton } from "../loaders/skeleton";
import { useState } from "react";
import DeleteDialog from "../common/models";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const Sidebar = ({ isOpen, onClose }: SidebarProps) => {
  const navigate = useNavigate();
  const conversations = useConversationStore((state) => state.conversations);
  const selectedConversation = useConversationStore(
    (state) => state.selectedConversation
  );
  const deleteConversation = useConversationStore(
    (state) => state.deleteConversation
  );

  const isInitialLoading = useConversationStore(
    (state) => state.isInitialLoading
  );

  const [conversationToDelete, setConversationToDelete] = useState<
    string | null
  >(null);

  const handleConfirmDelete = () => {
    if (conversationToDelete) {
      if (conversationToDelete === selectedConversation?.ID) {
        navigate("/");
      }
      deleteConversation(conversationToDelete);
      setConversationToDelete(null);
    }
  };

  // Handle clicks outside the sidebar (only on small screens)
  const handleOutsideClick = (e: React.MouseEvent) => {
    // Only trigger on the overlay element, not its children
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <>
      {/* Overlay for small screens - only visible when sidebar is open */}
      <div 
        onClick={handleOutsideClick}
        className={`md:hidden fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      />
      
      {/* Sidebar */}
      <div
        className={`fixed md:relative h-full z-50 md:z-auto bg-gray-950 border-r border-gray-800 w-80 transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-full flex flex-col">
          {/* Sidebar Header with Branding */}
          <div className="p-4 border-b border-gray-800">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center">
                <span className="text-purple-500 text-xl mr-2">
                  🤖
                </span>
                <h1 className="text-lg font-bold text-gray-200">Tiny Ollama Chat</h1>
              </div>
              <button
                onClick={onClose}
                className="p-1 hover:bg-gray-800 rounded-lg transition-colors duration-200"
              >
                <ChevronLeft className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <button
              onClick={() => {
                navigate("/");
                // Close sidebar on mobile when clicking New Chat
                if (window.innerWidth < 768) { // 768px is md breakpoint in Tailwind
                  onClose();
                }
              }}
              className="w-full flex items-center justify-center gap-2 py-2 bg-gray-800 hover:bg-purple-900/50 rounded-lg text-gray-200 text-sm transition-colors duration-200"
            >
              <Plus className="w-4 h-4" />
              New Chat
            </button>
          </div>
          {/* Conversation List */}
          <div className="flex-1 overflow-y-auto py-4">
            {isInitialLoading ? (
              <>
                <ConversationSkeleton />
                <ConversationSkeleton />
                <ConversationSkeleton />
              </>
            ) : (
              conversations.map((conv) => (
                <ConversationItem
                  key={conv.ID}
                  conversation={conv}
                  onDelete={() => setConversationToDelete(conv.ID)}
                  selectedConversationID={
                    selectedConversation?.ID ? selectedConversation.ID : ""
                  }
                  onSelect={() => {
                    // Close sidebar on mobile when selecting a conversation
                    if (window.innerWidth < 768) {
                      onClose();
                    }
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>
      {/* Delete Confirmation Dialog */}
      <DeleteDialog
        isOpen={!!conversationToDelete}
        onClose={() => setConversationToDelete(null)}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
};

export default Sidebar;
