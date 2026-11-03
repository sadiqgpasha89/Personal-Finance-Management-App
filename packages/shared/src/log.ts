/** One JSON object per line, easy to ship to any log pipeline. Never pass secrets, PAN, tokens or financial data. */
export const logger = (service: string) => {
  const w = (level: string, msg: string, extra?: Record<string, unknown>) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, service, msg, ...extra }) + '\n');
  return { info: (m: string, e?: Record<string, unknown>) => w('info', m, e), warn: (m: string, e?: Record<string, unknown>) => w('warn', m, e), error: (m: string, e?: Record<string, unknown>) => w('error', m, e) };
};
export type Logger = ReturnType<typeof logger>;
