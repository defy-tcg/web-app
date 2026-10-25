import { auth } from "@/lib/auth/server";

const handler = auth.handler();
// Do not expose provider admin, role, signup or impersonation methods through
// the catch-all proxy. Registration uses the approval-aware server action.
const allowed = new Set(['get-session','sign-in/email','sign-out','request-password-reset','reset-password','verify-email','send-verification-email','change-password','update-user','list-sessions','revoke-session','revoke-sessions','revoke-other-sessions']);
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const path = new URL(request.url).pathname.replace(/^\/api\/auth\//, '');
  if (!allowed.has(path)) return Response.json({ error: 'This authentication operation is unavailable.' }, { status: 403 });
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 });
  return request.method === 'GET' ? handler.GET(request, context) : handler.POST(request, context);
}
export const GET = handle;
export const POST = handle;
