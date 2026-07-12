import { useState } from 'react'
import Editor from './Editor'
import Characters from './Characters'

function App() {
  const [activeTab, setActiveTab] = useState('editor'); // 'editor', 'characters'

  return (
    <div className="min-h-screen flex flex-col selection:bg-cyan-500 selection:text-white pb-10">
      {/* Navbar matching api_module_building */}
      <nav className="bg-gray-900/90 backdrop-blur-md p-4 sticky top-0 z-50 border-b border-gray-800">
        <div className="container mx-auto flex justify-between items-center">
          <a href="/" className="text-xl font-bold text-cyan-400 hover:text-cyan-300 transition flex items-center gap-2 tracking-wide">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"></path></svg>
            Shadowplays Writer
          </a>
          <div className="flex items-center space-x-4">
            <button 
              className={`px-4 py-2 rounded text-sm font-bold transition ${activeTab === 'editor' ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-500/20' : 'text-gray-300 hover:text-cyan-400'}`}
              onClick={() => setActiveTab('editor')}
            >
              Editor
            </button>
            <button 
              className={`px-4 py-2 rounded text-sm font-bold transition ${activeTab === 'characters' ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-500/20' : 'text-gray-300 hover:text-cyan-400'}`}
              onClick={() => setActiveTab('characters')}
            >
              Characters
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <div className="container mx-auto px-6 mt-6 grow flex flex-col h-[calc(100vh-100px)]">
        {activeTab === 'editor' && <Editor />}
        {activeTab === 'characters' && <Characters />}
      </div>
    </div>
  )
}

export default App
