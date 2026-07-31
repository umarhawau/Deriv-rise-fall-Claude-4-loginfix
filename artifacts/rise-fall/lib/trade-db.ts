'use client';

const DB_NAME = 'pulseedge-trades';
const STORE_NAME = 'trades';
const DB_VERSION = 1;

export interface TradeRecord {
  id: string;
  timestamp: number;
  symbol: string;
  direction: 'CALL' | 'PUT';
  stake: number;
  payout: number;
  pnl: number;
  tier: string | null;
  outcome: 'WIN' | 'LOSS';
  isAutoSell: boolean;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('symbol', 'symbol', { unique: false });
        store.createIndex('outcome', 'outcome', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTradeRecord(record: TradeRecord): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    // IndexedDB unavailable (SSR, private mode) — silently skip
  }
}

export async function getAllTradeRecords(): Promise<TradeRecord[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('timestamp').getAll();
      req.onsuccess = () => {
        db.close();
        resolve((req.result as TradeRecord[]).sort((a, b) => a.timestamp - b.timestamp));
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function clearAllTradeRecords(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    // silent
  }
}
