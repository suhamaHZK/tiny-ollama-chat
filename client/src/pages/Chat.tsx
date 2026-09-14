import { useState, useEffect } from "react";
import Sidebar from "../components/chat/Sidebar.tsx";
import { ChevronRight, Plus, MessageCircle } from "lucide-react";
import ChatView from "../components/chat/ChatView.tsx";
import { useParams, useNavigate } from "react-router-dom";
import { useConversationStore } from "../store/conversationstore";

const ChatPage = () => {
  const navigate = useNavigate();
  const selectedModel = useConversationStore((state) => state.selectedModel);
  const selectedConversation = useConversationStore((state) => state.selectedConversation);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    // Check screen width and localStorage on initial render
    const savedState = localStorage.getItem('sidebarOpen');
    
    // On mobile (less than 768px width), default to closed regardless of saved state
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      return false;
    }
    
    // On desktop, use the saved state or default to true
    return savedState !== null ? savedState === 'true' : true;
  });
  
  const { id } = useParams(); // We'll keep it here since it's the parent component

  // Save sidebar state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('sidebarOpen', isSidebarOpen.toString());
  }, [isSidebarOpen]);

  // Handle window resize to close sidebar on mobile
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768 && isSidebarOpen) {
        setIsSidebarOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isSidebarOpen]);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-200">
      {/* Sidebar */}
      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      {/* Toggle Sidebar Button (shown when sidebar is closed) */}
      {!isSidebarOpen && (
        <div className="absolute top-0 left-0 z-10 p-4">
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="p-1.5 bg-gray-900 hover:bg-gray-800 rounded-lg transition-colors duration-200 flex items-center justify-center"
            aria-label="Open sidebar"
          >
            <ChevronRight className="w-5 h-5 text-gray-400" />
          </button>
        </div>
      )}

      {/* Content for empty space (desktop only, when sidebar is closed) */}
      {!isSidebarOpen && (
        <div className="hidden md:block fixed top-0 left-0 w-72 h-full bg-gradient-to-b from-gray-900/40 to-transparent pt-16 pb-4 px-4 overflow-y-auto">
          {/* Branding Card */}
          <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl p-4 border border-gray-800/50 shadow-lg mb-6 transform transition-all duration-300 hover:scale-105 hover:shadow-purple-900/20 hover:border-purple-800/30">
            <div className="flex items-center justify-center">
              <div className="text-purple-500 text-3xl mr-3">🤖</div>
              <h2 className="text-gray-200 text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-blue-400">Tiny Ollama Chat</h2>
            </div>
          </div>
            
          {/* New Chat Card */}
          <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl p-5 border border-gray-800/50 shadow-lg mb-6 transform transition-all duration-300 hover:scale-105 hover:shadow-purple-900/20 hover:border-purple-800/30 cursor-pointer group"
               onClick={() => navigate("/")}>
            <div className="flex items-center justify-center">
              <div className="w-10 h-10 rounded-full bg-purple-900/50 flex items-center justify-center mr-3 group-hover:bg-purple-800 transition-colors duration-300">
                <Plus className="w-5 h-5 text-purple-300" />
              </div>
              <span className="text-gray-200 font-semibold group-hover:text-white transition-colors duration-300">New Chat</span>
            </div>
          </div>
            
          {/* Current Model Card */}
          <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl p-5 border border-gray-800/50 shadow-lg transform transition-all duration-300 hover:scale-105 hover:shadow-purple-900/20 hover:border-purple-800/30">
            <div className="flex flex-col items-center text-center">
              <div className="w-12 h-12 rounded-full bg-purple-900/30 flex items-center justify-center mb-3">
                <MessageCircle className="w-6 h-6 text-purple-300" />
              </div>
              <span className="text-xs text-gray-400 mb-1">Current Model</span>
              <div className="text-gray-100 font-semibold text-lg">
                {selectedConversation ? 
                  selectedConversation.Model.split(":")[0] : 
                  selectedModel ? selectedModel.name.split(":")[0] : "Select a model"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 relative">
        <ChatView id={id} />
      </div>
    </div>
  );
};

export default ChatPage;