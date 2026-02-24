"use client";

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

const PUBLIC_ROUTES = ['/', '/login', '/recover', '/search', '/feed', '/chat'];

export default function AuthGuard({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

    useEffect(() => {
        const checkAuth = async () => {
            const did = localStorage.getItem('bucks_peer_id');
            const auth = localStorage.getItem('isAuthenticated') === 'true';
            const isAuthed = !!(did && auth);

            setIsAuthenticated(isAuthed);

            const isPublicRoute = PUBLIC_ROUTES.includes(pathname) || pathname.startsWith('/profile/');

            console.log(`[AuthGuard] Path: ${pathname}, Authed: ${isAuthed}, Public: ${isPublicRoute}`);

            if (isAuthed) {
                // Only check onboarding if not already on settings/onboarding
                if (pathname !== '/settings' && pathname !== '/login') {
                    try {
                        const { fetchProfile } = await import('@/lib/api');
                        const profile = await fetchProfile();
                        if (profile.onboarding) {
                            router.push('/settings?onboarding=true');
                        }
                    } catch (err) {
                        console.error('Failed to fetch profile during auth check', err);
                    }
                }
            } else {
                if (!isPublicRoute) {
                    console.log(`[AuthGuard] Redirecting guest from ${pathname} to /login`);
                    router.push('/login');
                }
            }
        };

        checkAuth();

        window.addEventListener('storage', checkAuth);
        return () => window.removeEventListener('storage', checkAuth);
    }, [pathname, router]);

    // Instant content for public routes or if we already know auth status
    const isPublicRoute = PUBLIC_ROUTES.includes(pathname);

    if (isAuthenticated === null && !isPublicRoute) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#030305]">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
        );
    }

    return <>{children}</>;
}
