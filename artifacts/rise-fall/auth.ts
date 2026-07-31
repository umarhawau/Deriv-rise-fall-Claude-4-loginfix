import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { checkLockout, recordFailure, clearAttempts } from "@/lib/admin-lockout";

export const { handlers, signIn, signOut, auth } = NextAuth({
  // Re-use the existing SESSION_SECRET so no new secret is required
  secret: process.env.SESSION_SECRET,
  // Required when running behind a reverse proxy (e.g. Replit) — tells
  // Auth.js to trust x-forwarded-host so CSRF token validation passes.
  trustHost: true,

  providers: [
    Credentials({
      id: "admin-credentials",
      name: "Admin",
      credentials: {
        token: { label: "Admin Secret Token", type: "password" },
        clientIp: { label: "Client IP", type: "text" },
      },
      async authorize(credentials) {
        const token = (credentials?.token as string | undefined)?.trim() ?? "";
        const ip = (credentials?.clientIp as string | undefined) ?? "unknown";
        const secret = process.env.ADMIN_SECRET;

        if (!secret) return null;

        // Belt-and-suspenders lockout check inside the provider as well
        const lockout = checkLockout(ip);
        if (!lockout.allowed) return null;

        if (token !== secret) {
          recordFailure(ip);
          return null;
        }

        clearAttempts(ip);
        return { id: "admin", name: "Admin" };
      },
    }),
  ],

  pages: {
    signIn: "/admin/quant",
    error: "/admin/quant",
  },

  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 8, // 8 hours — matches the old cookie maxAge
  },

  callbacks: {
    jwt({ token, user }) {
      if (user) token.isAdmin = true;
      return token;
    },
    session({ session, token }) {
      return { ...session, isAdmin: token.isAdmin ?? false };
    },
  },
});
