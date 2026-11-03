const csp = ["default-src 'self'", "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"), "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // the repo root, so ../packages/shared can be imported
/** @type {import('next').NextConfig} */
export default {
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined, outputFileTracingRoot: root, turbopack: { root },
  poweredByHeader: false,
  serverExternalPackages: ['pdfjs-dist'],
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: csp }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};
