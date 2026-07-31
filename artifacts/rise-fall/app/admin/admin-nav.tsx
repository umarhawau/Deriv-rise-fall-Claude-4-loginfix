'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

const TABS = [
  { label: '⚗️ Command Center', href: '/admin/quant' },
  { label: '📊 Symbol Performance', href: '/admin/symbols' },
  { label: '⏱️ Expiry Analytics', href: '/admin/expiry' },
  { label: '🔬 Signal Breakdown', href: '/admin/signal' },
  { label: '📋 Trade Log', href: '/admin/trades' },
  { label: '📉 Loss Patterns', href: '/admin/loss-patterns' },
  { label: '🔬 Calibration Lab', href: '/admin/calibration' },
  { label: '🗂 Market Profiles', href: '/admin/market-profiles' },
  { label: '⚙️ Global Settings', href: '/admin/settings' },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="w-8 h-8 shrink-0" />;

  const isDark = theme === 'dark';
  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-600 dark:text-zinc-300 hover:border-gray-300 dark:hover:border-zinc-600 transition-all"
    >
      {isDark ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
        </svg>
      )}
    </button>
  );
}

export function AdminNav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-2 w-full min-w-0">
      {/* Horizontally scrollable tab strip — swipeable on mobile */}
      <div className="flex-1 overflow-x-auto scrollbar-hide min-w-0">
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-xl p-1 w-max">
          {TABS.map((tab) => {
            const active = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
                  active
                    ? 'bg-violet-600 text-white shadow-sm'
                    : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200 hover:bg-white dark:hover:bg-zinc-800'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>
      {/* Theme toggle always visible, outside the scroll area */}
      <ThemeToggle />
    </div>
  );
}
