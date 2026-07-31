'use client';

export default function OfflinePage() {
  return (
    <main className="flex flex-col items-center justify-center min-h-dvh bg-background px-6 text-center gap-6">
      <div className="w-16 h-16 rounded-2xl overflow-hidden">
        <img src="/icon-192.png" alt="PulseEdge" className="w-full h-full object-contain" />
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">You&apos;re offline</h1>
        <p className="text-sm text-muted-foreground max-w-xs">
          PulseEdge needs a connection to stream live prices and place trades. Please check your network and try again.
        </p>
      </div>

      <button
        onClick={() => window.location.reload()}
        className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
      >
        Try again
      </button>
    </main>
  );
}
