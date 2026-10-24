import SignInForm from "./sign-in-form";
import { nativeReturnTo } from "@/lib/auth/return-to";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const query = await searchParams;
  return <SignInForm returnTo={nativeReturnTo(query.returnTo)} />;
}
