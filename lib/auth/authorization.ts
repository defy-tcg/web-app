import { auth } from "./server";

const DEFAULT_ALLOWED_EMAILS = [
  "nottandao@gmail.com",
  "setchasertcg@gmail.com",
];

function allowedEmails() {
  return new Set(
    (process.env.AUTHORIZED_EMAILS ?? DEFAULT_ALLOWED_EMAILS.join(","))
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(email: string | null | undefined) {
  return Boolean(email && allowedEmails().has(email.trim().toLowerCase()));
}

export async function getAuthorizedSession() {
  const { data: session } = await auth.getSession();
  if (!session?.user || !isAllowedEmail(session.user.email)) return null;
  return session;
}