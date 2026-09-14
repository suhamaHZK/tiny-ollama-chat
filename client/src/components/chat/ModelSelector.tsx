import React from "react";
import { ChevronDown } from "lucide-react";
import { Model } from "../../lib/types";
import { useConversationStore } from "../../store/conversationstore";

interface ModelSelectorProps {
  selectedModel: Model;
  onModelSelect: (model: Model) => void;
}

const ModelSelector = ({
  selectedModel,
  onModelSelect,
}: ModelSelectorProps) => {
  const models = useConversationStore((state) => state.models);
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-2 bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg transition-colors"
      >
        <div className="flex flex-col items-start">
          <span className="text-sm text-gray-200">{selectedModel.name}</span>
          <span className="text-xs text-gray-400">
            {selectedModel.details.parameter_size} parameters
          </span>
        </div>
        <ChevronDown className="w-4 h-4 text-gray-400" />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 w-full mt-2 bg-gray-800 rounded-lg shadow-lg overflow-hidden z-50">
          {models.map((model) => (
            <button
              key={model.model}
              onClick={() => {
                onModelSelect(model);
                setIsOpen(false);
              }}
              className={`w-full px-4 py-2 text-left hover:bg-gray-700 transition-colors ${
                selectedModel.model === model.model ? "bg-gray-700" : ""
              }`}
            >
              <div className="flex flex-col">
                <span className="text-sm text-gray-200">{model.name}</span>
                <span className="text-xs text-gray-400">
                  {model.details.parameter_size} parameters
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
