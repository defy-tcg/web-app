import SignUpForm from "./sign-up-form";
import { nativeReturnTo } from "@/lib/auth/return-to";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const query = await searchParams;
  return <SignUpForm returnTo={nativeReturnTo(query.returnTo)} />;
}
