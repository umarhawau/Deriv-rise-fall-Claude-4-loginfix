import { auth } from "@/auth";

/**
 * Returns true when the current request carries a valid admin session.
 * Used by admin page components as a defence-in-depth check;
 * the primary protection is the middleware in /middleware.ts.
 */
export async function isAdminAuthorized(): Promise<boolean> {
  const session = await auth();
  return !!session?.user;
}
