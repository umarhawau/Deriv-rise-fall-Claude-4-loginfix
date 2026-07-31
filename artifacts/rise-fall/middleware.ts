import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * Middleware — protects all /admin/* routes except the login page itself.
 * Auth.js sets req.auth when a valid JWT session cookie is present.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;

  // The login page must always be reachable (it's /admin/quant when not authed)
  const isLoginPage = pathname === "/admin/quant";
  if (isLoginPage) return NextResponse.next();

  // All other /admin/* paths require a valid admin session
  if (!req.auth) {
    const loginUrl = new URL("/admin/quant", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Run on every /admin path; skip Next.js internals and static assets
  matcher: ["/admin/:path*"],
};
