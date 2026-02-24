import React from 'react';
import UserProfilePageClient from './UserProfilePageClient';

export function generateStaticParams() {
    return [{ id: "default" }];
}

export default function UserProfilePage() {
    return <UserProfilePageClient />;
}
