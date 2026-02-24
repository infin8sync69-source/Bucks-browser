"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface ApiKeys {
    gemini: string;
    anthropic: string;
    openai: string;
}

interface ApiKeysContextType {
    keys: ApiKeys;
    setKey: (provider: keyof ApiKeys, key: string) => void;
    isLoaded: boolean;
}

const defaultKeys: ApiKeys = {
    gemini: '',
    anthropic: '',
    openai: ''
};

const ApiKeysContext = createContext<ApiKeysContextType | undefined>(undefined);

export const ApiKeysProvider = ({ children }: { children: ReactNode }) => {
    const [keys, setKeysState] = useState<ApiKeys>(defaultKeys);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        // Load keys from localStorage on mount
        const storedKeys = localStorage.getItem('bucks_api_keys');
        if (storedKeys) {
            try {
                setKeysState(JSON.parse(storedKeys));
            } catch (e) {
                console.error("Failed to parse stored API keys", e);
            }
        }
        setIsLoaded(true);
    }, []);

    const setKey = (provider: keyof ApiKeys, key: string) => {
        setKeysState(prev => {
            const newKeys = { ...prev, [provider]: key };
            localStorage.setItem('bucks_api_keys', JSON.stringify(newKeys));
            return newKeys;
        });
    };

    return (
        <ApiKeysContext.Provider value={{ keys, setKey, isLoaded }}>
            {children}
        </ApiKeysContext.Provider>
    );
};

export const useApiKeys = () => {
    const context = useContext(ApiKeysContext);
    if (!context) throw new Error('useApiKeys must be used within an ApiKeysProvider');
    return context;
};
