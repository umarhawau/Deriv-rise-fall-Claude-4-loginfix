'use client';

import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'pulseedge_install_prompt_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setVisible(false);
      setDeferredPrompt(null);
    }
  };

  const handleDismiss = () => {
    setVisible(false);
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* ignore */ }
  };

  if (!visible) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[9999] px-4 pb-safe-bottom"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
    >
      <div className="mx-auto max-w-md rounded-2xl border border-border bg-card shadow-2xl shadow-black/40 backdrop-blur-sm p-4">
        <div className="flex items-center gap-3">
          {/* Icon */}
          <div className="shrink-0 w-11 h-11 rounded-xl overflow-hidden bg-primary/10 flex items-center justify-center">
            <img src="/icon-192.png" alt="PulseEdge" className="w-9 h-9 object-contain" />
          </div>

          {/* Text */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground leading-tight">Add PulseEdge to your home screen</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
              Get the full app experience — trades, alerts &amp; charts.
            </p>
          </div>

          {/* Close */}
          <button
            onClick={handleDismiss}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Dismiss"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Buttons */}
        <div className="flex gap-2 mt-3">
          <button
            onClick={handleDismiss}
            className="flex-1 py-2 text-xs font-medium rounded-xl border border-border bg-transparent text-muted-foreground hover:bg-accent transition-colors"
          >
            Not now
          </button>
          <button
            onClick={handleInstall}
            className="flex-1 py-2 text-xs font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
