import type { ReactNode } from 'react';
import { Inter_Tight, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const uiFont = Inter_Tight({ subsets: ['latin'], variable: '--font-ui', display: 'swap' });
const monoFont = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata = { title: 'Loop | Tasks', description: 'Project tasks with live updates' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className={`${uiFont.variable} ${monoFont.variable}`}><body>{children}</body></html>;
}
