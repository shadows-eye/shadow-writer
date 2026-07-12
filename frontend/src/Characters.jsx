import { useState, useCallback } from 'react';
import { ReactFlow, Controls, Background, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, UserPlus } from 'lucide-react';

const initialNodes = [
  { id: '1', position: { x: 250, y: 150 }, data: { label: 'Protagonist: Elias' }, type: 'default', style: { background: '#1f2937', color: '#fff', border: '1px solid #06b6d4', borderRadius: '8px' } },
  { id: '2', position: { x: 450, y: 350 }, data: { label: 'Antagonist: Silas' }, type: 'default', style: { background: '#1f2937', color: '#fff', border: '1px solid #c084fc', borderRadius: '8px' } }
];

const initialEdges = [
  { id: 'e1-2', source: '1', target: '2', label: 'Rivals', animated: true, style: { stroke: '#9ca3af' } }
];

export default function Characters() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  
  // Dynamic Schema State
  const [availableFields, setAvailableFields] = useState(['Name', 'Role', 'Age', 'Species']);
  const [characters, setCharacters] = useState([
    { id: '1', fields: { Name: 'Elias', Role: 'Detective', Age: '34' } }
  ]);
  const [selectedChar, setSelectedChar] = useState(null);
  const [newFieldName, setNewFieldName] = useState('');

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), []);
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);

  const handleAddField = () => {
    if (newFieldName && !availableFields.includes(newFieldName)) {
      setAvailableFields([...availableFields, newFieldName]);
      
      if (selectedChar) {
          const updatedChars = characters.map(c => 
             c.id === selectedChar.id ? { ...c, fields: { ...c.fields, [newFieldName]: '' } } : c
          );
          setCharacters(updatedChars);
          setSelectedChar(updatedChars.find(c => c.id === selectedChar.id));
      }
      setNewFieldName('');
    }
  };

  const handleAddExistingField = (field) => {
    if (selectedChar && !selectedChar.fields[field]) {
        const updatedChars = characters.map(c => 
            c.id === selectedChar.id ? { ...c, fields: { ...c.fields, [field]: '' } } : c
        );
        setCharacters(updatedChars);
        setSelectedChar(updatedChars.find(c => c.id === selectedChar.id));
    }
  };

  const onNodeClick = (event, node) => {
      const char = characters.find(c => c.id === node.id);
      if (char) setSelectedChar(char);
      else setSelectedChar({ id: node.id, fields: { Name: node.data.label }}); // Mock fallback
  };

  return (
    <div className="flex h-full gap-6">
       {/* Sidebar for Character Details (Dynamic Schema) */}
       <div className="w-1/3 glass-panel p-4 rounded-lg flex flex-col overflow-y-auto">
          <h3 className="text-xl font-bold text-cyan-400 mb-4 flex items-center gap-2">
            <UserPlus size={20} /> Character Details
          </h3>
          
          {selectedChar ? (
              <div className="space-y-4">
                  {Object.entries(selectedChar.fields).map(([key, value]) => (
                      <div key={key} className="flex flex-col">
                          <label className="text-xs text-gray-400 font-bold uppercase tracking-wide mb-1">{key}</label>
                          <input 
                             type="text" 
                             value={value}
                             onChange={(e) => {
                                 const updated = characters.map(c => 
                                     c.id === selectedChar.id ? { ...c, fields: { ...c.fields, [key]: e.target.value } } : c
                                 );
                                 setCharacters(updated);
                                 setSelectedChar(updated.find(c => c.id === selectedChar.id));
                             }}
                             className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500" 
                          />
                      </div>
                  ))}
                  
                  <div className="mt-6 pt-4 border-t border-gray-700">
                      <h4 className="text-sm font-bold text-gray-300 mb-2">Add Field</h4>
                      <div className="flex flex-wrap gap-2 mb-3">
                         {availableFields.filter(f => !selectedChar.fields[f]).map(f => (
                             <button 
                               key={f} 
                               onClick={() => handleAddExistingField(f)}
                               className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-600 px-2 py-1 rounded text-gray-300"
                             >
                               + {f}
                             </button>
                         ))}
                      </div>
                      <div className="flex gap-2">
                          <input 
                            type="text" 
                            placeholder="New Custom Field..." 
                            value={newFieldName}
                            onChange={(e) => setNewFieldName(e.target.value)}
                            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 flex-grow text-sm text-white" 
                          />
                          <button onClick={handleAddField} className="bg-cyan-600 hover:bg-cyan-500 p-1 rounded">
                              <Plus size={20} className="text-white" />
                          </button>
                      </div>
                  </div>
              </div>
          ) : (
              <div className="text-gray-500 text-center mt-10">Select a character node in the graph to view/edit details.</div>
          )}
       </div>

       {/* Graph View */}
       <div className="w-2/3 glass-panel rounded-lg overflow-hidden relative">
          <ReactFlow 
            nodes={nodes} 
            edges={edges} 
            onNodesChange={onNodesChange} 
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            fitView
            className="bg-gray-900/50"
          >
            <Background color="#374151" gap={16} />
            <Controls className="bg-gray-800 border-gray-700 fill-white" />
          </ReactFlow>
       </div>
    </div>
  );
}
