'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';

export function AdminThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      {children}
    </NextThemesProvider>
  );
}
