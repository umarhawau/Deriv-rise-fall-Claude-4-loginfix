'use client';

import { useState, useEffect, useRef } from 'react';
import { ArrowUpRight, ArrowDownRight, Clock, ChevronLeft, X, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { useClosedPositions } from '@/hooks/use-closed-positions';
import type { ClosedPosition } from '@/hooks/use-closed-positions';
import type { OpenPosition } from '@/lib/types';
import type { DerivWS } from '@deriv/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(s: number): string {
  const S = Math.max(0, Math.floor(s));
  const h = Math.floor(S / 3600);
  const m = Math.floor((S % 3600) / 60);
  const sec = S % 60;
  if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function fmtDateTime(unix: number): { date: string; time: string } {
  const d = new Date(unix * 1000);
  return {
    date: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }),
  };
}

function usePositionTimer(pos: OpenPosition) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, pos.date_expiry - now);
}

function getDir(contractType: string) {
  const isCall = contractType.startsWith('CALL') || contractType === 'CALL';
  return { isCall, label: isCall ? 'Rise' : 'Fall', Icon: isCall ? ArrowUpRight : ArrowDownRight };
}

// ─── Sparkline (open positions) ───────────────────────────────────────────────

function Sparkline({ values, entryPrice }: { values: number[]; entryPrice: number }) {
  if (values.length < 2) {
    return (
      <div className="h-36 rounded-xl border border-border bg-card flex items-center justify-center text-xs text-muted-foreground">
        Collecting price data…
      </div>
    );
  }
  const W = 400; const H = 130;
  const allV = [entryPrice, ...values];
  const minV = Math.min(...allV); const maxV = Math.max(...allV);
  const range = maxV - minV || 0.0001;
  const lo = minV - range * 0.15; const hi = maxV + range * 0.15;
  const toY = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const toX = (i: number) => (i / (values.length - 1)) * W;
  const pts = values.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`);
  const line = `M ${pts.join(' L ')}`;
  const area = `${line} L ${W},${H} L 0,${H} Z`;
  const last = values[values.length - 1];
  const isUp = last >= entryPrice;
  const color = isUp ? '#10b981' : '#f43f5e';
  const entryY = toY(entryPrice);
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-36">
        <defs>
          <linearGradient id="sp-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={entryY} x2={W} y2={entryY} stroke="#888" strokeWidth="0.8" strokeDasharray="5 4" />
        <path d={area} fill="url(#sp-fill)" />
        <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={0} cy={entryY} r={5} fill="white" stroke="#666" strokeWidth="1.5" />
        <circle cx={W} cy={toY(last)} r={5} fill={color} />
        <rect x={W - 60} y={toY(last) - 12} width={58} height={20} rx={4} fill={color} />
        <text x={W - 31} y={toY(last) + 4} textAnchor="middle" fill="white" fontSize="10" fontWeight="bold" fontFamily="monospace">{last.toFixed(2)}</text>
        <rect x={W - 60} y={entryY - 12} width={58} height={20} rx={4} fill="#555" />
        <text x={W - 31} y={entryY + 4} textAnchor="middle" fill="white" fontSize="10" fontFamily="monospace">{entryPrice.toFixed(2)}</text>
      </svg>
    </div>
  );
}

// ─── Open position list card ──────────────────────────────────────────────────

function OpenPositionListCard({ pos, onClick }: { pos: OpenPosition; onClick: () => void }) {
  const remaining = usePositionTimer(pos);
  const { label, Icon } = getDir(pos.contract_type);
  const profit = parseFloat(pos.profit);
  const isProfit = profit >= 0;
  return (
    <button type="button" onClick={onClick}
      className="w-full text-left rounded-xl border border-border bg-card p-4 space-y-2.5 active:scale-[0.99] transition-transform">
      <div className="flex items-center justify-between">
        <Icon className="h-5 w-5 text-rose-500" />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span className="font-mono tabular-nums">{fmtTime(remaining)}</span>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{parseFloat(pos.buy_price).toFixed(2)} {pos.currency}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{getSymbolDisplayName(pos.underlying_symbol)}</span>
        <span className={cn('text-sm font-bold tabular-nums', isProfit ? 'text-emerald-500' : 'text-rose-500')}>
          {isProfit ? '+' : ''}{profit.toFixed(2)} {pos.currency}
        </span>
      </div>
    </button>
  );
}

// ─── Closed position list card ────────────────────────────────────────────────

function ClosedPositionListCard({ pos, onClick }: { pos: ClosedPosition; onClick: () => void }) {
  const { label, Icon } = getDir(pos.contract_type);
  const pnl = pos.sell_price - pos.buy_price;
  const isProfit = pnl >= 0;
  const { date, time } = fmtDateTime(pos.sell_time);
  return (
    <button type="button" onClick={onClick}
      className="w-full text-left rounded-xl border border-border bg-card p-4 space-y-2.5 active:scale-[0.99] transition-transform">
      <div className="flex items-center justify-between">
        <Icon className={cn('h-5 w-5', isProfit ? 'text-emerald-500' : 'text-rose-500')} />
        <span className="text-xs text-muted-foreground">{date} · {time.split(',')[0]}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{pos.buy_price.toFixed(2)} USD</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{getSymbolDisplayName(pos.underlying_symbol)}</span>
        <span className={cn('text-sm font-bold tabular-nums', isProfit ? 'text-emerald-500' : 'text-rose-500')}>
          {isProfit ? '+' : ''}{pnl.toFixed(2)} USD
        </span>
      </div>
    </button>
  );
}

// ─── Closed contract detail ───────────────────────────────────────────────────

interface ContractFull {
  entry_spot?: number | string;
  entry_spot_time?: number;
  exit_spot?: number | string;
  exit_spot_time?: number;
  date_start?: number;
  barrier?: string;
  duration?: number;
  duration_unit?: string;
  shortcode?: string;
}

function useClosedContractDetails(ws: DerivWS | null, contractId: number) {
  const [data, setData] = useState<ContractFull | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!ws) { setLoading(false); return; }
    setLoading(true);
    setData(null);
    (ws.send as (msg: unknown) => Promise<{ proposal_open_contract?: ContractFull }>)({
      proposal_open_contract: 1,
      contract_id: contractId,
    }).then(resp => {
      setData(resp.proposal_open_contract ?? null);
    }).catch(() => {
      setData(null);
    }).finally(() => setLoading(false));
  }, [ws, contractId]);
  return { data, loading };
}

function parseDuration(pos: ClosedPosition, details: ContractFull | null): string {
  if (details?.duration && details?.duration_unit) {
    const unit = details.duration_unit === 't' ? ' ticks' : details.duration_unit === 's' ? 's' : ` ${details.duration_unit}`;
    return `${details.duration}${unit}`;
  }
  const secs = pos.sell_time - pos.purchase_time;
  if (secs < 60) return `${secs} seconds`;
  const mins = Math.round(secs / 60);
  return `${mins} minute${mins !== 1 ? 's' : ''}`;
}

function ClosedContractDetail({
  pos, ws, onBack,
}: {
  pos: ClosedPosition;
  ws: DerivWS | null;
  onBack: () => void;
}) {
  const { data: details, loading } = useClosedContractDetails(ws, pos.contract_id);
  const { isCall, label, Icon } = getDir(pos.contract_type);
  const pnl = pos.sell_price - pos.buy_price;
  const isProfit = pnl >= 0;

  const start = fmtDateTime(pos.purchase_time);
  const end = fmtDateTime(pos.sell_time);
  const entrySpotTime = details?.entry_spot_time ? fmtDateTime(details.entry_spot_time) : null;
  const exitSpotTime = details?.exit_spot_time ? fmtDateTime(details.exit_spot_time) : null;
  const barrier = details?.barrier ?? '—';
  const duration = parseDuration(pos, details);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <button type="button" onClick={onBack} className="p-1 -ml-1 rounded-md hover:bg-muted transition-colors">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="font-semibold text-base flex-1">Contract details</h2>
      </div>

      <div className="flex-1 overflow-y-auto pb-8">
        {/* Direction summary card */}
        <div className="mx-4 mt-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between mb-2">
            <Icon className={cn('h-5 w-5 mt-0.5', isProfit ? 'text-emerald-500' : 'text-rose-500')} />
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              Closed
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{label}</span>
            <span className="text-sm font-semibold tabular-nums">{pos.buy_price.toFixed(2)} USD</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-sm text-muted-foreground">{getSymbolDisplayName(pos.underlying_symbol)}</span>
            <span className={cn('text-sm font-bold tabular-nums', isProfit ? 'text-emerald-500' : 'text-rose-500')}>
              {isProfit ? '+' : ''}{pnl.toFixed(2)} USD
            </span>
          </div>
        </div>

        {loading && (
          <div className="mx-4 mt-4 h-8 rounded-lg bg-muted/40 animate-pulse" />
        )}

        {/* Order Details */}
        <div className="mx-4 mt-4">
          <h3 className="text-sm font-semibold mb-3">Order Details</h3>
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            <DetailRow label="Reference ID">
              <div className="text-right">
                <div className="text-sm tabular-nums">{pos.contract_id} (Buy)</div>
                {pos.transaction_id && (
                  <div className="text-sm tabular-nums text-muted-foreground">{pos.transaction_id} (Sell)</div>
                )}
              </div>
            </DetailRow>
            <DetailRow label="Duration">
              <span className="text-sm">{duration}</span>
            </DetailRow>
            <DetailRow label="Barrier">
              <span className="text-sm tabular-nums">{barrier}</span>
            </DetailRow>
            <DetailRow label="Stake">
              <span className="text-sm tabular-nums">{pos.buy_price.toFixed(2)} USD</span>
            </DetailRow>
            <DetailRow label="Potential payout">
              <span className="text-sm tabular-nums">{pos.payout.toFixed(2)} USD</span>
            </DetailRow>
          </div>
        </div>

        {/* Entry & exit details */}
        <div className="mx-4 mt-4">
          <h3 className="text-sm font-semibold mb-3">Entry &amp; exit details</h3>
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            <DetailRow label="Start time">
              <div className="text-right">
                <div className="text-sm">{start.date}</div>
                <div className="text-xs text-muted-foreground">{start.time}</div>
              </div>
            </DetailRow>
            {details?.entry_spot ? (
              <DetailRow label="Entry spot">
                <div className="text-right">
                  <div className="text-sm tabular-nums">{Number(details.entry_spot).toFixed(2)}</div>
                  {entrySpotTime && (
                    <>
                      <div className="text-xs text-muted-foreground">{entrySpotTime.date}</div>
                      <div className="text-xs text-muted-foreground">{entrySpotTime.time}</div>
                    </>
                  )}
                </div>
              </DetailRow>
            ) : !loading && (
              <DetailRow label="Entry spot"><span className="text-sm text-muted-foreground">—</span></DetailRow>
            )}
            <DetailRow label="Exit time">
              <div className="text-right">
                <div className="text-sm">{end.date}</div>
                <div className="text-xs text-muted-foreground">{end.time}</div>
              </div>
            </DetailRow>
            {details?.exit_spot ? (
              <DetailRow label="Exit spot">
                <div className="text-right">
                  <div className="text-sm tabular-nums">{Number(details.exit_spot).toFixed(2)}</div>
                  {exitSpotTime && (
                    <>
                      <div className="text-xs text-muted-foreground">{exitSpotTime.date}</div>
                      <div className="text-xs text-muted-foreground">{exitSpotTime.time}</div>
                    </>
                  )}
                </div>
              </DetailRow>
            ) : !loading && (
              <DetailRow label="Exit spot"><span className="text-sm text-muted-foreground">—</span></DetailRow>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      {children}
    </div>
  );
}

// ─── Open contract detail ─────────────────────────────────────────────────────

function OpenContractDetail({
  pos, onBack, onSell, isSelling,
}: {
  pos: OpenPosition;
  onBack: () => void;
  onSell: (contractId: number, bidPrice: string) => Promise<void>;
  isSelling: boolean;
}) {
  const remaining = usePositionTimer(pos);
  const { label, Icon } = getDir(pos.contract_type);
  const profit = parseFloat(pos.profit);
  const isProfit = profit >= 0;
  const buyPrice = parseFloat(pos.buy_price);
  const bidPrice = parseFloat(pos.bid_price);
  const historyRef = useRef<number[]>([]);
  const [priceHistory, setPriceHistory] = useState<number[]>([]);

  useEffect(() => {
    const bid = parseFloat(pos.bid_price);
    if (!isNaN(bid) && bid > 0) {
      if (historyRef.current[historyRef.current.length - 1] !== bid) {
        historyRef.current = [...historyRef.current.slice(-199), bid];
        setPriceHistory([...historyRef.current]);
      }
    }
  }, [pos.bid_price]);

  const durationSec = pos.date_expiry - pos.date_start;
  const durationMin = Math.round(durationSec / 60);
  const durationDisplay = durationMin > 0
    ? `${durationMin} minute${durationMin !== 1 ? 's' : ''}`
    : `${durationSec} ticks`;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <button type="button" onClick={onBack} className="p-1 -ml-1 rounded-md hover:bg-muted transition-colors">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="font-semibold text-base flex-1">Contract details</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-28">
        <div className="rounded-xl border border-border bg-card p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <Icon className="h-5 w-5 text-rose-500" />
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span className="font-mono tabular-nums">{fmtTime(remaining)}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{label}</span>
            <span className="text-sm font-semibold tabular-nums">{buyPrice.toFixed(2)} {pos.currency}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{getSymbolDisplayName(pos.underlying_symbol)}</span>
            <span className={cn('text-sm font-bold tabular-nums', isProfit ? 'text-emerald-500' : 'text-rose-500')}>
              {isProfit ? '+' : ''}{profit.toFixed(2)} {pos.currency}
            </span>
          </div>
        </div>

        <Sparkline values={priceHistory} entryPrice={buyPrice} />

        <div className="space-y-3">
          <h3 className="font-semibold text-sm">Order Details</h3>
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            <DetailRow label="Reference ID">
              <span className="text-sm tabular-nums">{pos.contract_id} (Buy)</span>
            </DetailRow>
            <DetailRow label="Duration">
              <span className="text-sm">{durationDisplay}</span>
            </DetailRow>
            <DetailRow label="Stake">
              <span className="text-sm tabular-nums">{buyPrice.toFixed(2)} {pos.currency}</span>
            </DetailRow>
            <DetailRow label="Potential payout">
              <span className="text-sm tabular-nums">{parseFloat(pos.payout).toFixed(2)} {pos.currency}</span>
            </DetailRow>
          </div>
        </div>
      </div>

      <div className="shrink-0 p-4 border-t border-border bg-background">
        <button
          type="button"
          disabled={isSelling || pos.is_valid_to_sell !== 1}
          onClick={() => onSell(pos.contract_id, pos.bid_price)}
          className={cn(
            'w-full py-4 rounded-2xl font-bold text-base transition-colors',
            isSelling || pos.is_valid_to_sell !== 1
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-100'
          )}
        >
          {isSelling ? 'Closing…' : `Close ${isNaN(bidPrice) ? '' : bidPrice.toFixed(2)} ${pos.currency}`}
        </button>
      </div>
    </div>
  );
}

// ─── Main sheet ───────────────────────────────────────────────────────────────

export interface PositionsSheetProps {
  open: boolean;
  onClose: () => void;
  openPositions: OpenPosition[];
  onSell: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId: number | null;
  ws: DerivWS | null;
  isConnected: boolean;
  isAuthenticated: boolean;
}

export function PositionsSheet({
  open,
  onClose,
  openPositions,
  onSell,
  sellingId,
  ws,
  isConnected,
  isAuthenticated,
}: PositionsSheetProps) {
  const [activeTab, setActiveTab] = useState<'open' | 'closed'>('open');
  const [selectedOpen, setSelectedOpen] = useState<OpenPosition | null>(null);
  const [selectedClosed, setSelectedClosed] = useState<ClosedPosition | null>(null);

  const { positions: closedPositions, isLoading: closedLoading, refresh: refreshClosed } =
    useClosedPositions(ws, isConnected, isAuthenticated);

  const inDetail = selectedOpen !== null || selectedClosed !== null;

  // Keep selected open position in sync with live data
  useEffect(() => {
    if (!selectedOpen) return;
    const updated = openPositions.find(p => p.contract_id === selectedOpen.contract_id);
    if (updated) setSelectedOpen(updated);
    else setSelectedOpen(null);
  }, [openPositions]);

  // Refresh closed when tab becomes active
  useEffect(() => {
    if (open && activeTab === 'closed') refreshClosed();
  }, [open, activeTab]);

  // Reset on sheet close
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setSelectedOpen(null);
        setSelectedClosed(null);
        setActiveTab('open');
      }, 300);
      return () => clearTimeout(t);
    }
  }, [open]);

  const totalPnl = openPositions.reduce((sum, pos) => sum + (parseFloat(pos.profit) || 0), 0);
  const totalPositive = totalPnl >= 0;

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onClick={inDetail ? undefined : onClose} />

      <div className="fixed inset-x-0 bottom-0 z-50 bg-background rounded-t-2xl shadow-2xl flex flex-col" style={{ height: '93dvh' }}>

        {/* Drag handle + close */}
        <div className="flex items-center justify-between px-4 pt-3 pb-1 shrink-0">
          <div className="w-8" />
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Routed detail views */}
        {selectedOpen && (
          <OpenContractDetail
            pos={selectedOpen}
            onBack={() => setSelectedOpen(null)}
            onSell={onSell}
            isSelling={sellingId === selectedOpen.contract_id}
          />
        )}

        {selectedClosed && (
          <ClosedContractDetail
            pos={selectedClosed}
            ws={ws}
            onBack={() => setSelectedClosed(null)}
          />
        )}

        {/* List view (hidden behind detail via conditional, not unmounted so state is preserved) */}
        {!inDetail && (
          <>
            {/* ── Full-width tabs ── */}
            <div className="flex w-full border-b border-border shrink-0">
              {(['open', 'closed'] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'flex-1 py-3 text-sm font-semibold capitalize border-b-2 transition-colors',
                    activeTab === tab
                      ? 'border-foreground text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Open: total P&L banner */}
            {activeTab === 'open' && openPositions.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
                <span className="text-sm font-semibold">Total profit/loss:</span>
                <span className={cn('text-sm font-bold tabular-nums', totalPositive ? 'text-emerald-500' : 'text-rose-500')}>
                  {totalPositive ? '+' : ''}{totalPnl.toFixed(2)} USD
                </span>
              </div>
            )}

            {/* Closed: refresh row */}
            {activeTab === 'closed' && (
              <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
                <span className="text-xs text-muted-foreground">Last 50 trades</span>
                <button
                  type="button"
                  onClick={refreshClosed}
                  disabled={closedLoading}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={cn('h-3 w-3', closedLoading && 'animate-spin')} />
                  Refresh
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 pb-6">
              {activeTab === 'open' && (
                openPositions.length === 0
                  ? <p className="text-center text-sm text-muted-foreground py-16">No open positions</p>
                  : openPositions.map(pos => (
                    <OpenPositionListCard key={pos.contract_id} pos={pos} onClick={() => setSelectedOpen(pos)} />
                  ))
              )}

              {activeTab === 'closed' && (
                closedLoading
                  ? [1, 2, 3].map(i => <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />)
                  : closedPositions.length === 0
                    ? <p className="text-center text-sm text-muted-foreground py-16">No closed positions yet</p>
                    : closedPositions.map(pos => (
                      <ClosedPositionListCard key={pos.contract_id} pos={pos} onClick={() => setSelectedClosed(pos)} />
                    ))
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
