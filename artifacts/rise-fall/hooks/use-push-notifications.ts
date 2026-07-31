'use client';

import { useState, useEffect, useCallback } from 'react';

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

const API_BASE = '/api';

async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/push/vapid-public-key`);
    if (!res.ok) return null;
    const data = await res.json() as { publicKey?: string };
    return data.publicKey ?? null;
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function usePushNotifications(userToken: string | null) {
  const [permission, setPermission] = useState<PushPermission>('default');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission as PushPermission);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        if (sub) {
          setSubscription(sub);
          setIsSubscribed(true);
        }
      });
    });
  }, []);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!userToken) return false;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;

    setIsLoading(true);
    try {
      const permission = await Notification.requestPermission();
      setPermission(permission as PushPermission);
      if (permission !== 'granted') return false;

      const publicKey = await getVapidPublicKey();
      if (!publicKey) {
        console.warn('[PushEdge] VAPID public key not available');
        return false;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const res = await fetch(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: userToken, subscription: sub.toJSON() }),
      });

      if (!res.ok) {
        await sub.unsubscribe();
        return false;
      }

      setSubscription(sub);
      setIsSubscribed(true);
      return true;
    } catch (err) {
      console.error('[PushEdge] subscribe error', err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [userToken]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    if (!subscription) return;
    setIsLoading(true);
    try {
      await fetch(`${API_BASE}/push/unsubscribe`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
      setSubscription(null);
      setIsSubscribed(false);
    } catch (err) {
      console.error('[PushEdge] unsubscribe error', err);
    } finally {
      setIsLoading(false);
    }
  }, [subscription]);

  const sendTradeNotification = useCallback(
    async (params: {
      title: string;
      body: string;
      url?: string;
    }): Promise<void> => {
      if (!userToken || !isSubscribed) return;
      try {
        await fetch(`${API_BASE}/push/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: userToken,
            title: params.title,
            body: params.body,
            icon: '/icon-192.png',
            url: params.url ?? '/',
          }),
        });
      } catch (err) {
        console.error('[PushEdge] notify error', err);
      }
    },
    [userToken, isSubscribed],
  );

  return {
    permission,
    isSubscribed,
    isLoading,
    subscribe,
    unsubscribe,
    sendTradeNotification,
  };
}