"use server";

import { signIn, signOut } from "@/auth";
import { headers } from "next/headers";
import { checkLockout, recordFailure } from "@/lib/admin-lockout";

export async function loginAction(
  _prev: { error: string | null },
  formData: FormData,
) {
  const token = (formData.get("token") as string | null)?.trim() ?? "";
  const secret = process.env.ADMIN_SECRET;

  if (!secret) {
    return { error: "ADMIN_SECRET is not configured on this server." };
  }

  // Resolve the caller's IP for brute-force tracking
  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    hdrs.get("x-real-ip") ??
    "unknown";

  // Check lockout before touching the secret
  const lockout = checkLockout(ip);
  if (!lockout.allowed) {
    const mins = Math.ceil(lockout.retryAfterSec / 60);
    return {
      error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? "s" : ""}.`,
    };
  }

  // Validate password before calling signIn so we can return a rich error
  if (token !== secret) {
    const status = recordFailure(ip);
    if (!status.allowed) {
      return {
        error: "Too many failed attempts. Admin access locked for 15 minutes.",
      };
    }
    const rem = status.remaining;
    return {
      error:
        rem > 0
          ? `Invalid admin token. ${rem} attempt${rem !== 1 ? "s" : ""} remaining before lockout.`
          : "Invalid admin token.",
    };
  }

  // Credentials are valid — establish the Auth.js JWT session.
  // signIn() throws a Next.js redirect internally on success; it never returns normally.
  await signIn("admin-credentials", {
    token,
    clientIp: ip,
    redirectTo: "/admin/quant",
  });
}

export async function logoutAction() {
  await signOut({ redirectTo: "/admin/quant" });
}
