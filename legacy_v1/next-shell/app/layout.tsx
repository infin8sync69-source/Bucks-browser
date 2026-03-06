import type { Metadata } from 'next';
import { Outfit } from 'next/font/google';
import './globals.css';
import AuthGuard from '@/components/AuthGuard';
import { ToastProvider } from '@/components/Toast';

import ClientLayout from '@/components/ClientLayout';
import { BrowserProvider } from '@/context/BrowserContext';
import { ApiKeysProvider } from '@/context/ApiKeysContext';

const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit' });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning className={`${outfit.variable} font-sans bg-transparent text-foreground antialiased`}>
        <AuthGuard>
          <ApiKeysProvider>
            <BrowserProvider>
              <ToastProvider>
                <ClientLayout>
                  {children}
                </ClientLayout>
              </ToastProvider>
            </BrowserProvider>
          </ApiKeysProvider>
        </AuthGuard>
      </body>
    </html>
  );
}
