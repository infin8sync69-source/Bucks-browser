"use client";

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApiKeys } from '@/context/ApiKeysContext';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Bot, User, ArrowUp, AlertCircle, MessageSquare, KeyRound, Check } from 'lucide-react';
import { SiGooglegemini, SiOpenai, SiAnthropic } from 'react-icons/si';

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

export default function ChatPage() {
    return (
        <React.Suspense fallback={<div className="flex justify-center items-center h-full text-white/50 p-8 animate-pulse">Loading Interface...</div>}>
            <ChatContent />
        </React.Suspense>
    );
}

function ChatContent() {
    const searchParams = useSearchParams();
    const { keys, isLoaded } = useApiKeys();

    const initialQuery = searchParams.get('q') || '';
    const initialModel = searchParams.get('model') || 'Gemini 3.1 Pro (High)';

    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const hasInitialized = useRef(false);

    // Get styling and icons based on model name
    const getModelDetails = () => {
        if (initialModel.includes('Gemini')) return { icon: SiGooglegemini, color: 'text-blue-400', bg: 'bg-blue-500/10', provider: 'gemini' as const };
        if (initialModel.includes('Claude')) return { icon: SiAnthropic, color: 'text-orange-400', bg: 'bg-orange-500/10', provider: 'anthropic' as const };
        if (initialModel.includes('GPT')) return { icon: SiOpenai, color: 'text-emerald-400', bg: 'bg-emerald-500/10', provider: 'openai' as const };
        return { icon: Bot, color: 'text-purple-400', bg: 'bg-purple-500/10', provider: 'gemini' as const };
    };

    const { icon: ModelIcon, color: modelColor, bg: modelBg, provider } = getModelDetails();
    const hasKey = !!keys[provider];

    useEffect(() => {
        if (isLoaded && initialQuery && hasKey && !hasInitialized.current) {
            hasInitialized.current = true;
            handleSendMessage(initialQuery);
        }
    }, [isLoaded, initialQuery, hasKey]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isLoading]);

    const handleSendMessage = async (text: string) => {
        if (!text.trim()) return;

        setError(null);
        setMessages(prev => [...prev, { role: 'user', content: text }]);
        setInput('');
        setIsLoading(true);

        // Pre-create assistant message for streaming/typing
        setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

        try {
            if (initialModel.includes('Gemini')) {
                if (!keys.gemini) throw new Error("Google Gemini API Key is not configured. Please add it from the Home screen search bar.");

                const genAI = new GoogleGenerativeAI(keys.gemini);
                // The free tier API explicitly blocks the Pro models (2.5-pro, 3.1-pro) with a quota of 0.
                // We degrade both the "High" and "Flash" UI selections to use the `gemini-2.5-flash` model which works on free tier.
                const modelStr = 'gemini-2.5-flash';
                const model = genAI.getGenerativeModel({ model: modelStr });

                // Format history for Gemini
                const history = messages.map(m => ({
                    role: m.role === 'user' ? 'user' : 'model',
                    parts: [{ text: m.content }]
                }));

                const chat = model.startChat({ history });
                const result = await chat.sendMessageStream(text);

                let fullResponse = '';
                for await (const chunk of result.stream) {
                    const chunkText = chunk.text();
                    fullResponse += chunkText;
                    setMessages(prev => {
                        const newMsgs = [...prev];
                        newMsgs[newMsgs.length - 1].content = fullResponse;
                        return newMsgs;
                    });
                }
            } else {
                // Mock responses for Claude and GPT for now since we only have client-side SDK for Google atm
                throw new Error(`${initialModel} native integration is coming soon. Please configure the Gemini API key and select a Gemini model.`);
            }
        } catch (err: any) {
            setMessages(prev => {
                const newMsgs = [...prev];
                // Remove the empty assistant message if it failed immediately, otherwise append error
                if (newMsgs[newMsgs.length - 1].content === '') {
                    newMsgs.pop();
                }
                return newMsgs;
            });
            setError(err.message || "Failed to generate response");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-[calc(100vh-80px)] w-full max-w-4xl mx-auto p-4 animate-fade-in relative z-10">
            {/* Header */}
            <div className="flex items-center justify-between pb-6 mb-4 border-b border-white/5">
                <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-2xl ${modelBg} flex items-center justify-center border border-white/10`}>
                        <ModelIcon size={20} className={modelColor} />
                    </div>
                    <div>
                        <h2 className="text-lg font-light tracking-wide text-white">{initialModel}</h2>
                        <p className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Conversational Swarm AI</p>
                    </div>
                </div>
            </div>

            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto no-scrollbar pb-32 mb-4 space-y-6">
                {messages.length === 0 && !isLoading && !error && (
                    <div className="h-full flex flex-col items-center justify-center text-center opacity-80">
                        {hasKey ? (
                            <>
                                <MessageSquare size={32} className={`mb-4 ${modelColor} opacity-50`} />
                                <h3 className="text-xl font-light text-white mb-2">How can I help you?</h3>
                                <p className="text-xs text-white/50 max-w-sm">I can answer questions, analyze data, and assist with your web exploration.</p>
                            </>
                        ) : (
                            <div className="max-w-md w-full p-6 liquid-glass rounded-3xl border border-white/10 text-center animate-in fade-in zoom-in-95 duration-500">
                                <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center mx-auto mb-4 border border-white/10">
                                    <KeyRound size={20} className={modelColor} />
                                </div>
                                <h3 className="text-lg font-medium text-white mb-1">API Key Required</h3>
                                <p className="text-xs text-white/50 mb-6">Please configure your {initialModel.split(' ')[0]} API key to start chatting.</p>

                                <input
                                    type="password"
                                    value={apiKeyInput}
                                    onChange={(e) => setApiKeyInput(e.target.value)}
                                    placeholder={`Paste API Key here...`}
                                    className="w-full bg-black/40 border border-white/10 rounded-xl py-2.5 px-4 text-sm text-white/90 placeholder-white/30 outline-none focus:bg-white/5 focus:border-white/30 transition-all mb-3 text-center"
                                    autoFocus
                                />
                                <button
                                    onClick={() => {
                                        if (apiKeyInput.trim()) {
                                            try {
                                                const ctxObj = require('react').useContext(require('@/context/ApiKeysContext').ApiKeysContext);
                                                if (ctxObj && ctxObj.setKey) {
                                                    ctxObj.setKey(provider, apiKeyInput.trim());
                                                    setApiKeyInput('');
                                                    if (initialQuery && !hasInitialized.current) {
                                                        hasInitialized.current = true;
                                                        handleSendMessage(initialQuery);
                                                    }
                                                }
                                            } catch (e) { }
                                        }
                                    }}
                                    className="w-full bg-white/10 hover:bg-white/20 text-white/90 py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg border border-white/5 active:scale-[0.98]"
                                >
                                    Save Key & Start
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`flex max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                            {msg.role === 'assistant' && (
                                <div className={`w-6 h-6 rounded-lg ${modelBg} border border-white/10 flex items-center justify-center mr-2 mt-0.5 flex-shrink-0`}>
                                    <ModelIcon size={12} className={modelColor} />
                                </div>
                            )}
                            <div
                                className={`px-4 py-2.5 text-sm rounded-2xl ${msg.role === 'user'
                                    ? 'bg-white text-black rounded-tr-sm ml-2'
                                    : 'bg-white/5 text-white/90 border border-white/10 rounded-tl-sm'
                                    }`}
                                style={{ whiteSpace: 'pre-wrap' }}
                            >
                                {msg.content}
                                {msg.role === 'assistant' && isLoading && idx === messages.length - 1 && (
                                    <span className="inline-block w-1.5 h-3 bg-white/50 ml-1 mt-0.5 animate-pulse" />
                                )}
                            </div>
                        </div>
                    </div>
                ))}

                {error && (
                    <div className="flex justify-center my-4">
                        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-2xl flex items-center space-x-3 max-w-md">
                            <AlertCircle size={16} className="flex-shrink-0" />
                            <span className="text-xs">{error}</span>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input Form */}
            <div className="absolute bottom-4 left-4 right-4">
                <form
                    onSubmit={(e) => { e.preventDefault(); handleSendMessage(input); }}
                    className="relative max-w-4xl mx-auto"
                >
                    <div className="liquid-glass flex items-center p-1.5 rounded-3xl border border-white/10 shadow-2xl focus-within:border-white/30 focus-within:shadow-[0_0_20px_rgba(255,255,255,0.05)] transition-all">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder={hasKey ? "Message AI directly..." : "Configure API key to type..."}
                            className="w-full bg-transparent text-white/90 placeholder-white/30 outline-none text-sm py-2 px-4 tracking-wide"
                            disabled={isLoading || !hasKey}
                            autoFocus={hasKey}
                        />
                        <div className="pr-1">
                            <button
                                type="submit"
                                disabled={!input.trim() || isLoading || !hasKey}
                                className={`w-8 h-8 flex items-center justify-center rounded-full transition-all shadow-lg active:scale-95 ${input.trim() && !isLoading && hasKey ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-transparent text-white/20'}`}
                            >
                                <ArrowUp size={16} strokeWidth={2.5} />
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
