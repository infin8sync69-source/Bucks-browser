import React from 'react';
import ChatPageClient from './ChatPageClient';

export function generateStaticParams() {
    return [{ peer_id: "default" }];
}

export default function ChatPage() {
    return <ChatPageClient />;
}
