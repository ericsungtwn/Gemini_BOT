/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ChatInterface } from './components/ChatInterface';
import { Sidebar } from './components/Sidebar';
import { Message } from './types';
import { gemini } from './services/geminiService';
import { Send, Terminal, ShieldCheck, Zap } from 'lucide-react';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // Load history on mount
  useEffect(() => {
    fetch('/api/messages')
      .then(res => res.json())
      .then(data => setMessages(data))
      .catch(err => console.error('Failed to load history:', err));

    const playNotificationSound = () => {
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        const chirp = (time: number) => {
          const oscillator = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();

          oscillator.type = 'sine';
          // High pitch bird-like frequency sweep
          oscillator.frequency.setValueAtTime(2500, time);
          oscillator.frequency.exponentialRampToValueAtTime(4000, time + 0.05);
          oscillator.frequency.exponentialRampToValueAtTime(3000, time + 0.1);

          gainNode.gain.setValueAtTime(0, time);
          gainNode.gain.linearRampToValueAtTime(0.1, time + 0.02);
          gainNode.gain.linearRampToValueAtTime(0, time + 0.1);

          oscillator.connect(gainNode);
          gainNode.connect(audioCtx.destination);

          oscillator.start(time);
          oscillator.stop(time + 0.1);
        };

        // Double chirp for a more "bird-like" feel
        chirp(audioCtx.currentTime);
        chirp(audioCtx.currentTime + 0.12);
      } catch (e) {
        console.error('Failed to play sound:', e);
      }
    };

    const connectWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      const socket = new WebSocket(wsUrl);

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'NEW_MESSAGE') {
            // Play sound for incoming messages
            playNotificationSound();
            
            setMessages(prev => {
              const exists = prev.some(m => 
                m.content === data.message.content && 
                m.role === data.message.role &&
                Math.abs(new Date(m.timestamp || 0).getTime() - new Date(data.message.timestamp).getTime()) < 5000
              );
              if (exists) return prev;
              return [...prev, data.message];
            });
          } else if (data.type === 'CLEAR_HISTORY') {
            setMessages([]);
          }
        } catch (err) {
          console.error('WebSocket message error:', err);
        }
      };

      socket.onclose = () => {
        console.log('WebSocket disconnected. Reconnecting in 3s...');
        setTimeout(connectWebSocket, 3000);
      };

      return socket;
    };

    const socket = connectWebSocket();
    return () => socket.close();
  }, []);

  const saveMessage = async (role: 'user' | 'model', content: string) => {
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, content })
      });
      return await res.json();
    } catch (err) {
      console.error('Failed to save message:', err);
    }
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isTyping) return;

    const userText = input.trim();
    setInput('');
    
    // Optimistic update
    const userMsg: Message = { role: 'user', content: userText, timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    await saveMessage('user', userText);

    setIsTyping(true);
    try {
      const { text, functionCalls } = await gemini.chat(userText, messages);
      
      let finalResponse = text;

      if (functionCalls && functionCalls.length > 0) {
        for (const call of functionCalls) {
          if (call.name === 'sendTelegramMessage') {
            const { message: telegramMsg, delayMs } = call.args;
            try {
              const res = await fetch('/api/telegram/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: telegramMsg, delayMs })
              });
              if (res.ok) {
                const data = await res.json();
                if (data.status === 'scheduled') {
                  finalResponse += `\n\n[System: Reminder scheduled for ${delayMs/1000}s from now]`;
                } else {
                  finalResponse += `\n\n[System: Telegram message sent successfully]`;
                }
              } else {
                const errData = await res.json();
                finalResponse += `\n\n[System Error: ${errData.error || 'Check configuration'}]`;
              }
            } catch (err) {
              finalResponse += `\n\n[System: Error connecting to Telegram API.]`;
            }
          } else if (call.name === 'browseWeb') {
            const { url, action } = call.args;
            try {
              const res = await fetch('/api/browser', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, action })
              });
              if (res.ok) {
                const data = await res.json();
                if (action === 'content') {
                  finalResponse += `\n\n🌐 **網頁摘要 (${url}):**\n${data.content}`;
                } else if (action === 'screenshot') {
                  finalResponse += `\n\n![Screenshot of ${url}](${data.screenshot})`;
                }
              } else {
                const errData = await res.json();
                finalResponse += `\n\n[Browser Error: ${errData.error}]`;
              }
            } catch (err) {
              finalResponse += `\n\n[System: Error connecting to Browser API.]`;
            }
          } else if (call.name === 'syncToGitHub') {
            try {
              const res = await fetch('/api/github/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              if (res.ok) {
                const data = await res.json();
                finalResponse += `\n\n🚀 **GitHub 同步結果:**\n${data.result}`;
              } else {
                const errData = await res.json();
                finalResponse += `\n\n[GitHub Error: ${errData.error}]`;
              }
            } catch (err) {
              finalResponse += `\n\n[System: Error connecting to GitHub Sync API.]`;
            }
          }
        }
      }

      const modelMsg: Message = { role: 'model', content: finalResponse || "Action completed.", timestamp: new Date().toISOString() };
      setMessages(prev => [...prev, modelMsg]);
      await saveMessage('model', finalResponse || "Action completed.");
    } catch (err) {
      console.error('Chat error:', err);
      const errorMsg: Message = { role: 'model', content: "Error: Failed to connect to neural core.", timestamp: new Date().toISOString() };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  const clearHistory = async () => {
    // Using a simpler check as confirm() can sometimes be blocked in iframes
    const proceed = window.confirm('Are you sure you want to wipe all persistent memory?');
    if (!proceed) return;
    
    try {
      const res = await fetch('/api/messages', { method: 'DELETE' });
      if (res.ok) {
        setMessages([]);
        // Add a temporary system message to show it worked
        const systemMsg: Message = { 
          role: 'model', 
          content: "[System: Persistent memory has been wiped clean.]", 
          timestamp: new Date().toISOString() 
        };
        setMessages([systemMsg]);
      } else {
        alert('Failed to clear memory on server.');
      }
    } catch (err) {
      console.error('Failed to clear history:', err);
      alert('Error connecting to server to clear memory.');
    }
  };

  return (
    <div className="h-screen w-screen flex bg-[#050505] text-white font-sans overflow-hidden">
      {/* Main Terminal Area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-16 border-b border-white/10 flex items-center justify-between px-8 bg-[#0a0a0a]">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Zap size={20} className="text-indigo-500" />
              <h1 className="font-mono font-bold text-lg uppercase tracking-tighter">ClawWeb Assistant</h1>
            </div>
            <div className="h-4 w-px bg-white/10" />
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase opacity-40">
              <ShieldCheck size={12} className="text-emerald-500" />
              <span>Environment: Secure Sandbox</span>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="text-right">
              <div className="text-[9px] font-mono uppercase opacity-30">Neural Core</div>
              <div className="text-[11px] font-mono text-indigo-400">Gemini 3 Flash</div>
            </div>
          </div>
        </header>

        {/* Chat Area */}
        <ChatInterface messages={messages} isTyping={isTyping} />

        {/* Input Area */}
        <footer className="p-6 border-t border-white/10 bg-[#0a0a0a]">
          <form onSubmit={handleSend} className="max-w-4xl mx-auto relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-lg blur opacity-10 group-focus-within:opacity-20 transition duration-500" />
            <div className="relative flex items-center bg-[#050505] border border-white/10 rounded-lg overflow-hidden focus-within:border-indigo-500/50 transition-colors">
              <div className="pl-4 text-white/20">
                <Terminal size={18} />
              </div>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Enter command or query..."
                className="flex-1 bg-transparent border-none focus:ring-0 text-sm font-mono p-4 placeholder:text-white/10"
                disabled={isTyping}
              />
              <button
                type="submit"
                disabled={!input.trim() || isTyping}
                className="p-4 text-indigo-500 hover:text-indigo-400 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={18} />
              </button>
            </div>
            <div className="mt-2 flex justify-between px-1">
              <span className="text-[9px] font-mono uppercase opacity-20">Press Enter to execute</span>
              <span className="text-[9px] font-mono uppercase opacity-20">Persistent memory active</span>
            </div>
          </form>
        </footer>
      </main>

      {/* Sidebar */}
      <Sidebar onClearHistory={clearHistory} messageCount={messages.length} />
    </div>
  );
}
