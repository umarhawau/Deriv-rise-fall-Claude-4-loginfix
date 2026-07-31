'use client';

import { useEffect, useRef, useState } from 'react';
import type { DerivWS } from '@deriv/core';

interface BalanceResponse {
  balance?: {
    balance: number;
    currency: string;
    loginid: string;
  };
}

/**
 * Subscribes to Deriv's live balance stream and calls `onBalanceUpdate`
 * whenever the balance changes (after a trade, sell, deposit, etc.).
 * Also returns the account currency live from the balance stream.
 * Automatically re-subscribes when the WS connection or account changes.
 */
export function useBalance(
  ws: DerivWS | null,
  isConnected: boolean,
  activeAccountId: string | null,
  onBalanceUpdate: (accountId: string, balance: string) => void
): { currency: string | null } {
  const [currency, setCurrency] = useState<string | null>(null);
  const onBalanceUpdateRef = useRef(onBalanceUpdate);
  useEffect(() => { onBalanceUpdateRef.current = onBalanceUpdate; }, [onBalanceUpdate]);

  useEffect(() => {
    if (!ws || !isConnected || !activeAccountId) return;

    let sub: { unsubscribe: () => void } | null = null;
    let cancelled = false;

    ws.subscribe(
      { balance: 1, subscribe: 1 },
      (data) => {
        const res = data as unknown as BalanceResponse;
        if (res.balance) {
          const { loginid, balance, currency: cur } = res.balance;
          onBalanceUpdateRef.current(loginid, String(balance));
          if (cur) setCurrency(cur);
        }
      }
    )
      .then((s) => {
        if (cancelled) { s.unsubscribe(); return; }
        sub = s;
      })
      .catch(() => { /* WS not yet authenticated — silent fail, will retry on reconnect */ });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [ws, isConnected, activeAccountId]);

  return { currency };
}
