'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { DerivWS as DerivWSType } from '@deriv/core';
import { fetchAllActiveSymbols } from '@/lib/active-symbols-ws';

export interface SmartChartsSubscribeParams {
  symbol: string;
  granularity?: number;
  style?: string;
}

export interface SmartChartsGetQuotesParams {
  symbol: string;
  granularity?: number;
  count?: number;
  start?: number;
  end?: number;
}

export interface UseSmartChartsApiReturn {
  requestAPI: (request: Record<string, unknown>) => Promise<unknown>;
  getQuotes: (params: SmartChartsGetQuotesParams) => Promise<unknown>;
  subscribeQuotes: (
    params: SmartChartsSubscribeParams,
    callback: (quote: Record<string, unknown>) => void
  ) => () => void;
  unsubscribeQuotes: (request?: { symbol?: string; granularity?: number }) => void;
}

export function useSmartChartsApi(ws: DerivWSType | null): UseSmartChartsApiReturn {
  const wsRef = useRef<DerivWSType | null>(ws);
  const subscriptionRefs = useRef<Record<string, () => void>>({});

  useEffect(() => {
    wsRef.current = ws;
  }, [ws]);

  useEffect(() => {
    return () => {
      for (const unsub of Object.values(subscriptionRefs.current)) {
        unsub();
      }
      subscriptionRefs.current = {};
    };
  }, []);

  /**
   * Called by SmartCharts for trading_times, server_time, active_symbols, etc.
   *
   * - trading_times / server_time: mocked instantly (options endpoint doesn't support them)
   * - active_symbols: routed through a SEPARATE standard Deriv WS connection so the
   *   SmartCharts market browser always shows ALL markets (Forex, Metals, Indices,
   *   Synthetics), not just the ones the options-scoped trading endpoint exposes.
   *   Falls back to the trading WS if the standard WS fails for any reason.
   * - Everything else: trading WS with exponential back-off retry.
   */
  const requestAPI = useCallback(
    (request: Record<string, unknown>): Promise<unknown> => {
      // Instant mock — prevents "Retrieving Trading Times…" hang
      if ('trading_times' in request) {
        return Promise.resolve({
          trading_times: { markets: [] },
          msg_type: 'trading_times',
        });
      }

      // Instant mock — safe to use local clock
      if ('server_time' in request) {
        return Promise.resolve({
          time: Math.floor(Date.now() / 1000),
          msg_type: 'server_time',
        });
      }

      // active_symbols: use a dedicated standard Deriv WS connection that returns
      // ALL markets, regardless of which product endpoint the trading session uses.
      if ('active_symbols' in request) {
        return fetchAllActiveSymbols(request).catch(() => {
          // If the standard WS fails, fall back to the trading WS (no product_type).
          const { product_type: _drop, ...broadRequest } = request;
          return attemptTradingWs(broadRequest, 5);
        });
      }

      // All other SmartCharts requests → trading WS with back-off retry
      return attemptTradingWs(request, 5);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  function attemptTradingWs(req: Record<string, unknown>, retries: number): Promise<unknown> {
    const currentWs = wsRef.current;
    if (!currentWs || !currentWs.isConnected) {
      if (retries <= 0) return Promise.reject(new Error('WebSocket not ready'));
      return new Promise(resolve => setTimeout(resolve, 600))
        .then(() => attemptTradingWs(req, retries - 1));
    }
    return currentWs.send(req).catch((err: unknown) => {
      if (retries <= 0) throw err;
      const delay = Math.min(600 * Math.pow(2, 5 - retries), 10_000);
      return new Promise(resolve => setTimeout(resolve, delay))
        .then(() => attemptTradingWs(req, retries - 1));
    });
  }

  const getQuotes = useCallback(
    async ({ symbol, granularity, count, start, end }: SmartChartsGetQuotesParams) => {
      if (!wsRef.current) throw new Error('WebSocket not connected');
      const request: Record<string, unknown> = {
        ticks_history: symbol,
        style: granularity ? 'candles' : 'ticks',
        count: count ?? 1000,
        end: end ? String(end) : 'latest',
        adjust_start_time: 1,
      };
      if (granularity) request.granularity = granularity;
      if (start) request.start = String(start);
      return wsRef.current.send(request);
    },
    []
  );

  const subscribeQuotes = useCallback(
    (
      { symbol, granularity, style }: SmartChartsSubscribeParams,
      callback: (quote: Record<string, unknown>) => void
    ): (() => void) => {
      if (!wsRef.current) return () => { };
      const key = `${symbol}-${granularity ?? 0}`;
      const request: Record<string, unknown> = {
        ticks_history: symbol,
        style: style || granularity ? 'candles' : 'ticks',
        adjust_start_time: 1,
        count: 1,
        end: 'latest',
      };
      if (granularity) request.granularity = granularity;

      let unsubscribeFn: () => void = () => { };

      wsRef.current.subscribe(request, (response: Record<string, unknown>) => {
        if (response.tick) {
          const tick = response.tick as { epoch: number; quote: number };
          callback({
            Date: new Date(tick.epoch * 1000).toISOString(),
            Close: tick.quote,
            tick,
            DT: new Date(tick.epoch * 1000),
          });
        }
        if (response.ohlc) {
          const ohlc = response.ohlc as {
            open_time: number;
            open: string;
            high: string;
            low: string;
            close: string;
          };
          callback({
            Date: new Date(ohlc.open_time * 1000).toISOString(),
            Open: parseFloat(ohlc.open),
            High: parseFloat(ohlc.high),
            Low: parseFloat(ohlc.low),
            Close: parseFloat(ohlc.close),
            ohlc,
            DT: new Date(ohlc.open_time * 1000),
          });
        }
      })
        .then(({ unsubscribe }) => {
          unsubscribeFn = unsubscribe;
          subscriptionRefs.current[key] = unsubscribe;
        })
        .catch(() => { });

      return () => {
        unsubscribeFn();
        delete subscriptionRefs.current[key];
      };
    },
    []
  );

  const unsubscribeQuotes = useCallback((request?: { symbol?: string; granularity?: number }) => {
    if (!request?.symbol) return;
    const key = `${request.symbol}-${request.granularity ?? 0}`;
    const unsubscribe = subscriptionRefs.current[key];
    if (unsubscribe) {
      unsubscribe();
      delete subscriptionRefs.current[key];
    }
  }, []);

  return {
    requestAPI,
    getQuotes,
    subscribeQuotes,
    unsubscribeQuotes,
  };
}
