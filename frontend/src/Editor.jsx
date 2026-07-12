import { useState, useRef, useEffect } from 'react';
import { Sparkles } from 'lucide-react';

export default function Editor() {
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('Chapter 1');
  const [contextMenu, setContextMenu] = useState(null);
  const textAreaRef = useRef(null);

  const handleContextMenu = (e) => {
    e.preventDefault();
    const selection = window.getSelection().toString();
    
    // Only show menu if text is selected
    if (selection.trim().length > 0) {
      setContextMenu({
        x: e.pageX,
        y: e.pageY,
        selectedText: selection
      });
    } else {
      setContextMenu(null);
    }
  };

  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    document.addEventListener('click', closeContextMenu);
    return () => document.removeEventListener('click', closeContextMenu);
  }, []);

  const handleAIAction = async (action) => {
    if (!contextMenu) return;
    
    // Placeholder for calling backend/MCP tool
    console.log(`Executing AI Action: ${action} on text: "${contextMenu.selectedText}"`);
    
    // Mock update just to show functionality
    const replacement = `[AI ${action.toUpperCase()}: ${contextMenu.selectedText}]`;
    const newContent = content.replace(contextMenu.selectedText, replacement);
    setContent(newContent);
    setContextMenu(null);
  };

  const handleSave = async () => {
    try {
      const response = await fetch('/api/save-chapter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-123',
          chapterId: 'chapter-1',
          title: title,
          content: content
        })
      });
      const data = await response.json();
      if (data.success) {
        alert('Saved and committed to Git!');
      } else {
        alert('Error saving: ' + data.error);
      }
    } catch (err) {
      alert('Network error saving chapter.');
    }
  };

  return (
    <div className="flex-grow flex flex-col relative h-full">
      <div className="flex justify-between items-center mb-4">
          <input 
             className="text-2xl font-bold bg-transparent border-b border-gray-700 text-white outline-none focus:border-cyan-500 pb-1"
             value={title}
             onChange={e => setTitle(e.target.value)}
          />
          <button 
             onClick={handleSave}
             className="bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2 px-6 rounded transition shadow-lg shadow-cyan-500/20"
          >
            Save & Push
          </button>
      </div>
      
      <div className="glass-panel p-6 rounded-lg flex-grow flex flex-col mb-6 relative">
         <textarea 
            ref={textAreaRef}
            className="w-full h-full min-h-[50vh] bg-transparent text-gray-200 resize-none outline-none focus:ring-0 leading-relaxed" 
            placeholder="Write your chapter here... Select text and right-click for AI tools."
            value={content}
            onChange={e => setContent(e.target.value)}
            onContextMenu={handleContextMenu}
         />
      </div>

      {/* Custom Context Menu */}
      {contextMenu && (
        <div 
          className="absolute z-50 bg-gray-800 border border-gray-700 shadow-xl rounded-lg overflow-hidden py-1"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-xs text-cyan-400 font-bold border-b border-gray-700 flex items-center gap-1 mb-1">
             <Sparkles size={12} /> AI Tools
          </div>
          <button 
             className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition"
             onClick={() => handleAIAction('rewrite')}
          >
             Rewrite
          </button>
          <button 
             className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition"
             onClick={() => handleAIAction('expand')}
          >
             Expand
          </button>
          <button 
             className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition"
             onClick={() => handleAIAction('tone')}
          >
             Make Grittier
          </button>
        </div>
      )}
    </div>
  );
}
