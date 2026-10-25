import { auth } from "./server";
import { activeAccount, activeEmail } from "./accounts";

export const isAllowedEmail = activeEmail;
export async function getAuthorizedSession() {
  const { data: session } = await auth.getSession();
  if (!session?.user || !await activeAccount(session.user.id, session.user.email)) return null;
  return session;
}
