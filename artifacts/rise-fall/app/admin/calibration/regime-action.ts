"use server";

import { db } from "@workspace/db";
import { tradeLogsTable, systemSettingsTable } from "@workspace/db/schema";
import { eq, ne, and, gte, sql } from "drizzle-orm";
import OpenAI from "openai";
import { headers } from "next/headers";
import { checkRateLimit } from "@/lib/rate-limit";

const nimClient = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_NIM_API_KEY ?? "",
});

const MODEL = "nvidia/nemotron-3-super-120b-a12b";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RegimeWindow {
  label: string;
  totalResolved: number;
  callWinRate: number | null;
  putWinRate: number | null;
  overallWinRate: number | null;
  avgErAtEntry: number | null;
  avgAbsZScore: number | null;
  avgNoise: number | null;
  callPct: number | null;
}

export interface RegimeSignals {
  window7d: RegimeWindow;
  window30d: RegimeWindow;
  windowAll: RegimeWindow;
  /** CALL WR − PUT WR in 7d window; positive = bullish tilt */
  callPutWrDelta7d: number | null;
  /** 7d overall WR − 30d overall WR; positive = improving */
  wrTrend: number | null;
  /** avg ER 7d − avg ER 30d; positive = stronger signals recently */
  erShift: number | null;
  /** avg noise 7d − avg noise 30d; positive = noisier recently */
  noiseShift: number | null;
}

export interface RegimeThresholds {
  sniperCallErMin: number;
  sniperPutErMin: number;
  balancedCallErMin: number;
  balancedPutErMin: number;
  aggressiveCallErMin: number;
  aggressivePutErMin: number;
}

export interface RegimeProposal {
  regime: string;
  regimeEmoji: string;
  confidence: "high" | "medium" | "low";
  summary: string;
  currentThresholds: RegimeThresholds;
  suggestedThresholds: RegimeThresholds;
  reasoning: string;
  thinking: string;
}

export interface RegimeActionResult {
  signals: RegimeSignals;
  proposal: RegimeProposal;
}

type ActionResult<T> = { success: true; data: T } | { success: false; error: string };

// ── Data helpers ─────────────────────────────────────────────────────────────

interface RawRow {
  direction: string;
  status: string;
  er: number;
  z: number;
  noise: number;
}

function calcWindow(rows: RawRow[], label: string): RegimeWindow {
  const resolved = rows.filter((r) => r.status !== "PENDING");
  const calls = resolved.filter((r) => r.direction === "CALL");
  const puts = resolved.filter((r) => r.direction === "PUT");
  const callWins = calls.filter((r) => r.status === "WIN").length;
  const putWins = puts.filter((r) => r.status === "WIN").length;
  const allWins = resolved.filter((r) => r.status === "WIN").length;
  const n = resolved.length;

  return {
    label,
    totalResolved: n,
    callWinRate: calls.length >= 5 ? (callWins / calls.length) * 100 : null,
    putWinRate: puts.length >= 5 ? (putWins / puts.length) * 100 : null,
    overallWinRate: n >= 5 ? (allWins / n) * 100 : null,
    avgErAtEntry: n > 0 ? resolved.reduce((s, r) => s + r.er, 0) / n : null,
    avgAbsZScore: n > 0 ? resolved.reduce((s, r) => s + Math.abs(r.z), 0) / n : null,
    avgNoise: n > 0 ? resolved.reduce((s, r) => s + r.noise, 0) / n : null,
    callPct: n > 0 ? (calls.length / n) * 100 : null,
  };
}

function fmtWindow(w: RegimeWindow): string {
  const pct = (v: number | null) => (v != null ? `${v.toFixed(1)}%` : "N/A");
  const dec = (v: number | null) => (v != null ? v.toFixed(3) : "N/A");
  return [
    `  Period: ${w.label} (${w.totalResolved} resolved trades)`,
    `  Overall WR: ${pct(w.overallWinRate)}  |  CALL WR: ${pct(w.callWinRate)}  |  PUT WR: ${pct(w.putWinRate)}`,
    `  Avg ER at entry: ${dec(w.avgErAtEntry)}  |  Avg |z-score|: ${dec(w.avgAbsZScore)}  |  Avg noise: ${dec(w.avgNoise)}`,
    `  CALL/PUT split: ${w.callPct != null ? `${w.callPct.toFixed(0)}% CALL` : "N/A"}`,
  ].join("\n");
}

function buildPrompt(signals: RegimeSignals, current: RegimeThresholds): string {
  const fmt = (v: number | null, suffix = "") =>
    v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}${suffix}` : "N/A";

  return `You are a quantitative trading systems analyst specialising in regime detection for binary-options signal systems.

## Your task
1. Classify the current market regime from the trade-performance signals below.
2. Propose temporary ER (Expected Return) gate threshold adjustments tuned to this regime.

## Regime taxonomy (choose the BEST fit)
- TRENDING_BULLISH  — CALL win-rate materially exceeds PUT; rising market directional bias
- TRENDING_BEARISH  — PUT win-rate materially exceeds CALL; falling market directional bias
- RANGING           — CALL and PUT win-rates converge; mean-reversion dominant
- HIGH_VOLATILITY   — High noise & z-scores; wide signal scatter; WR degraded across modes
- LOW_VOLATILITY    — Low noise; tight z-scores; signals very clean; WR elevated
- REGIME_SHIFT      — 7-day performance significantly deviates from 30-day baseline
- INSUFFICIENT_DATA — Fewer than 20 resolved trades in the 7-day window

## Performance signals

### 7-day window
${fmtWindow(signals.window7d)}

### 30-day window
${fmtWindow(signals.window30d)}

### All-time window
${fmtWindow(signals.windowAll)}

### Regime shift indicators
  CALL WR − PUT WR (7d):          ${fmt(signals.callPutWrDelta7d, "pp")}
  7d overall WR − 30d overall WR: ${fmt(signals.wrTrend, "pp")}
  Avg ER shift (7d − 30d):        ${fmt(signals.erShift)}
  Avg noise shift (7d − 30d):     ${fmt(signals.noiseShift)}

## Current global ER gate thresholds
  sniperCallErMin:     ${current.sniperCallErMin.toFixed(2)}
  sniperPutErMin:      ${current.sniperPutErMin.toFixed(2)}
  balancedCallErMin:   ${current.balancedCallErMin.toFixed(2)}
  balancedPutErMin:    ${current.balancedPutErMin.toFixed(2)}
  aggressiveCallErMin: ${current.aggressiveCallErMin.toFixed(2)}
  aggressivePutErMin:  ${current.aggressivePutErMin.toFixed(2)}

## Threshold rules (must satisfy after adjustment)
  sniperCallErMin >= balancedCallErMin >= aggressiveCallErMin
  sniperPutErMin  >= balancedPutErMin  >= aggressivePutErMin
  All values: multiples of 0.05, range [0.00, 0.60]

## Regime-specific guidance
- TRENDING_BULLISH:  raise PUT gates (reduce noise), optionally lower CALL gates slightly
- TRENDING_BEARISH:  raise CALL gates, optionally lower PUT gates slightly
- RANGING:           symmetric gates; moderate values; trust both directions equally
- HIGH_VOLATILITY:   raise all gates across the board to filter out noisy signals
- LOW_VOLATILITY:    lower gates slightly; signals are clean; allow more volume
- REGIME_SHIFT:      raise all gates conservatively until the new regime is confirmed
- INSUFFICIENT_DATA: return current values unchanged

Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON:
{
  "regime": "<REGIME_CODE>",
  "regimeEmoji": "<single emoji>",
  "confidence": "<high|medium|low>",
  "summary": "<2-3 sentence plain-English explanation of the detected regime and why thresholds should change>",
  "reasoning": "<1-2 sentences on the specific threshold changes and the data points driving them>",
  "suggestions": {
    "sniperCallErMin": <number>,
    "sniperPutErMin": <number>,
    "balancedCallErMin": <number>,
    "balancedPutErMin": <number>,
    "aggressiveCallErMin": <number>,
    "aggressivePutErMin": <number>
  }
}`;
}

function extractThinkingAndContent(raw: string): { thinking: string; content: string } {
  const m = raw.match(/<think>([\s\S]*?)<\/think>/i);
  const thinking = m ? m[1].trim() : "";
  const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { thinking, content };
}

function snapTo005(v: number): number {
  return Math.round(Math.round(v / 0.05) * 0.05 * 100) / 100;
}
function clamp(v: number): number {
  return Math.max(0, Math.min(0.6, snapTo005(v)));
}

// ── Main server action ───────────────────────────────────────────────────────

export async function detectRegimeAndSuggest(): Promise<ActionResult<RegimeActionResult>> {
  if (!process.env.NVIDIA_NIM_API_KEY) {
    return { success: false, error: "NVIDIA_NIM_API_KEY is not configured on the server." };
  }

  // Rate limit: 10 requests per 5 minutes per IP — server action calling paid NVIDIA NIM API.
  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    hdrs.get("x-real-ip") ??
    "unknown";
  const rl = checkRateLimit(`nim-regime:${ip}`, { limit: 10, windowMs: 5 * 60 * 1000 });
  if (!rl.allowed) {
    const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
    return {
      success: false,
      error: `Rate limit exceeded — too many requests. Please wait ${retryAfterSec} seconds and try again.`,
    };
  }

  try {
    const now = new Date();
    const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Fetch all resolved GHOST trades and current settings in parallel
    const [allRows, settingsRows] = await Promise.all([
      db
        .select({
          direction: tradeLogsTable.direction,
          status: tradeLogsTable.status,
          erAtEntry: tradeLogsTable.erAtEntry,
          zScoreAtEntry: tradeLogsTable.zScoreAtEntry,
          noiseAtEntry: tradeLogsTable.noiseAtEntry,
          createdAt: tradeLogsTable.createdAt,
        })
        .from(tradeLogsTable)
        .where(
          and(
            eq(tradeLogsTable.executionType, "GHOST"),
            ne(tradeLogsTable.status, "PENDING"),
          ),
        ),
      db.select().from(systemSettingsTable).limit(1),
    ]);

    const toRow = (r: typeof allRows[0]): RawRow => ({
      direction: r.direction,
      status: r.status,
      er: parseFloat(r.erAtEntry ?? "0"),
      z: parseFloat(r.zScoreAtEntry ?? "0"),
      noise: parseFloat(r.noiseAtEntry ?? "0"),
    });

    const rows7d = allRows.filter((r) => r.createdAt >= cutoff7d).map(toRow);
    const rows30d = allRows.filter((r) => r.createdAt >= cutoff30d).map(toRow);
    const rowsAll = allRows.map(toRow);

    const w7d = calcWindow(rows7d, "Last 7 days");
    const w30d = calcWindow(rows30d, "Last 30 days");
    const wAll = calcWindow(rowsAll, "All-time");

    const signals: RegimeSignals = {
      window7d: w7d,
      window30d: w30d,
      windowAll: wAll,
      callPutWrDelta7d:
        w7d.callWinRate != null && w7d.putWinRate != null
          ? w7d.callWinRate - w7d.putWinRate
          : null,
      wrTrend:
        w7d.overallWinRate != null && w30d.overallWinRate != null
          ? w7d.overallWinRate - w30d.overallWinRate
          : null,
      erShift:
        w7d.avgErAtEntry != null && w30d.avgErAtEntry != null
          ? w7d.avgErAtEntry - w30d.avgErAtEntry
          : null,
      noiseShift:
        w7d.avgNoise != null && w30d.avgNoise != null
          ? w7d.avgNoise - w30d.avgNoise
          : null,
    };

    const s = settingsRows[0];
    const current: RegimeThresholds = {
      sniperCallErMin: parseFloat(String(s?.sniperCallErMin ?? "0")),
      sniperPutErMin: parseFloat(String(s?.sniperPutErMin ?? "0")),
      balancedCallErMin: parseFloat(String(s?.balancedCallErMin ?? "0")),
      balancedPutErMin: parseFloat(String(s?.balancedPutErMin ?? "0")),
      aggressiveCallErMin: parseFloat(String(s?.aggressiveCallErMin ?? "0")),
      aggressivePutErMin: parseFloat(String(s?.aggressivePutErMin ?? "0")),
    };

    // Call NVIDIA NIM
    const completion = await nimClient.chat.completions.create({
      model: MODEL,
      // @ts-expect-error — NVIDIA NIM reasoning fields not in OpenAI SDK types
      reasoning_budget: 16384,
      chat_template_kwargs: { enable_thinking: true },
      max_tokens: 16384,
      temperature: 1.0,
      top_p: 0.95,
      messages: [{ role: "user", content: buildPrompt(signals, current) }],
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    const { thinking, content } = extractThinkingAndContent(rawText);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { success: false, error: "Model did not return valid JSON." };

    let parsed: {
      regime: string;
      regimeEmoji: string;
      confidence: string;
      summary: string;
      reasoning: string;
      suggestions: Record<string, number>;
    };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { success: false, error: "Failed to parse model JSON output." };
    }

    const sg = parsed.suggestions ?? {};
    const aggressiveCall = clamp(sg.aggressiveCallErMin ?? current.aggressiveCallErMin);
    const balancedCall = clamp(Math.max(sg.balancedCallErMin ?? current.balancedCallErMin, aggressiveCall));
    const sniperCall = clamp(Math.max(sg.sniperCallErMin ?? current.sniperCallErMin, balancedCall));
    const aggressivePut = clamp(sg.aggressivePutErMin ?? current.aggressivePutErMin);
    const balancedPut = clamp(Math.max(sg.balancedPutErMin ?? current.balancedPutErMin, aggressivePut));
    const sniperPut = clamp(Math.max(sg.sniperPutErMin ?? current.sniperPutErMin, balancedPut));

    const proposal: RegimeProposal = {
      regime: parsed.regime ?? "UNKNOWN",
      regimeEmoji: parsed.regimeEmoji ?? "🔍",
      confidence: (parsed.confidence ?? "low") as "high" | "medium" | "low",
      summary: parsed.summary ?? "",
      reasoning: parsed.reasoning ?? "",
      thinking,
      currentThresholds: current,
      suggestedThresholds: {
        sniperCallErMin: sniperCall,
        sniperPutErMin: sniperPut,
        balancedCallErMin: balancedCall,
        balancedPutErMin: balancedPut,
        aggressiveCallErMin: aggressiveCall,
        aggressivePutErMin: aggressivePut,
      },
    };

    return { success: true, data: { signals, proposal } };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Regime detection error: ${message}` };
  }
}
