import { handle } from '@/lib/api';
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };
const h = async (req: Request, { params }: Ctx) => handle(req, (await params).path);
export { h as GET, h as POST, h as PATCH, h as PUT, h as DELETE };
