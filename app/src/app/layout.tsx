import './globals.css';
import type { Metadata, Viewport } from 'next';
export const metadata: Metadata = { title: 'Ledgerly — personal finance', description: 'Know where your money goes and what is safe to spend.', manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { themeColor: '#146e5a', width: 'device-width', initialScale: 1 };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}` }} /></head>
      <body>{children}</body>
    </html>
  );
}
