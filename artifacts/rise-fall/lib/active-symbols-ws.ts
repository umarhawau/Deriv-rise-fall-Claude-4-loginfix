'use client';

/**
 * Fetches active_symbols from the **standard** Deriv WebSocket endpoint
 * (wss://ws.binaryws.com) using a dedicated short-lived connection.
 *
 * This is intentionally separate from the options-scoped trading WS so the
 * SmartCharts market browser always shows ALL markets — Forex, Metals, Indices,
 * and Synthetics — regardless of which product endpoint the trading session uses.
 *
 * The result is module-cached so the round-trip only happens once per page load.
 */

let cache: Promise<unknown> | null = null;

function getStandardWsUrl(): string {
  const appId =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_DERIV_APP_ID) || '1';
  return `wss://ws.binaryws.com/websockets/v3?app_id=${appId}`;
}

export function fetchAllActiveSymbols(
  request: Record<string, unknown>
): Promise<unknown> {
  if (cache) return cache;

  cache = new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(getStandardWsUrl());
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    function settle(value?: unknown, err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err) {
        cache = null;
        reject(err);
      } else {
        resolve(value);
      }
    }

    // Build the request: strip product_type (the field that scopes to synthetics)
    // and req_id (we inject our own so the response matches).
    const { product_type: _p, req_id: _r, ...clean } = request as Record<string, unknown>;
    const payload = JSON.stringify({ ...clean, req_id: 9900 });

    ws.onopen = () => ws.send(payload);

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as Record<string, unknown>;
        if ('active_symbols' in data) settle(data);
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => settle(undefined, new Error('Standard Deriv WS error'));

    ws.onclose = () => {
      if (!settled) settle(undefined, new Error('Standard Deriv WS closed before symbols arrived'));
    };

    // Safety timeout — don't block SmartCharts indefinitely
    timer = setTimeout(
      () => settle(undefined, new Error('fetchAllActiveSymbols timed out after 10s')),
      10_000
    );
  });

  return cache;
}
