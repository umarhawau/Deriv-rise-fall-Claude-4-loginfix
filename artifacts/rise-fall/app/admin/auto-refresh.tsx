'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export function AutoRefresh({ intervalSeconds = 30 }: { intervalSeconds?: number }) {
  const router = useRouter();
  const [countdown, setCountdown] = useState(intervalSeconds);

  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          router.refresh();
          return intervalSeconds;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [router, intervalSeconds]);

  return (
    <span className="text-[10px] text-gray-400 dark:text-zinc-600 tabular-nums">
      ↻ {countdown}s
    </span>
  );
}
