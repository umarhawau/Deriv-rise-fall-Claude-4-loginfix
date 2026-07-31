import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";

// NVIDIA NIM is OpenAI-compatible — we use the openai SDK with a custom base URL.
const nimClient = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_NIM_API_KEY ?? "",
});

const MODEL = "nvidia/nemotron-3-super-120b-a12b";

// Rate limit: 10 requests per 5 minutes per IP — each call hits the paid NVIDIA NIM API.
const AI_RATE_LIMIT = { limit: 10, windowMs: 5 * 60 * 1000 };

export interface BucketRow {
  label: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
}

export interface SuggestRequest {
  overallBuckets: BucketRow[];
  callBuckets: BucketRow[];
  putBuckets: BucketRow[];
  currentSettings: {
    sniperCallErMin: number | string;
    sniperPutErMin: number | string;
    balancedCallErMin: number | string;
    balancedPutErMin: number | string;
    aggressiveCallErMin: number | string;
    aggressivePutErMin: number | string;
  };
}

export interface SuggestResponse {
  suggestions: {
    sniperCallErMin: number;
    sniperPutErMin: number;
    balancedCallErMin: number;
    balancedPutErMin: number;
    aggressiveCallErMin: number;
    aggressivePutErMin: number;
  };
  reasoning: string;
  thinking: string;
}

function fmtBuckets(rows: BucketRow[]): string {
  return rows
    .map((r) => {
      const wr = r.winRate != null ? `${r.winRate.toFixed(1)}%` : "N/A";
      return `  ${r.label.padEnd(10)} | ${String(r.total).padStart(5)} trades | ${r.wins}W / ${r.losses}L | win-rate: ${wr}`;
    })
    .join("\n");
}

function buildPrompt(body: SuggestRequest): string {
  const { overallBuckets, callBuckets, putBuckets, currentSettings: cs } = body;

  return `You are a quantitative trading systems analyst. Your job is to recommend optimal ER (Expected Return) gate thresholds for a binary-options ghost-trading system.

## Context
The system has three trading modes — each with separate CALL and PUT minimum ER thresholds:
- **Sniper** (most conservative — only highest-quality signals)
- **Balanced** (moderate quality/volume tradeoff)
- **Aggressive** (lower bar — higher volume, more risk)

The 6 thresholds you must suggest values for (all in range 0.00–0.60, step 0.05):
  sniperCallErMin, sniperPutErMin, balancedCallErMin, balancedPutErMin, aggressiveCallErMin, aggressivePutErMin

**Hard constraints:**
  sniperCallErMin >= balancedCallErMin >= aggressiveCallErMin  (conservative >= moderate >= aggressive)
  sniperPutErMin  >= balancedPutErMin  >= aggressivePutErMin
  All values must be multiples of 0.05 in range [0.00, 0.60]

## Current thresholds
  sniperCallErMin:     ${cs.sniperCallErMin}
  sniperPutErMin:      ${cs.sniperPutErMin}
  balancedCallErMin:   ${cs.balancedCallErMin}
  balancedPutErMin:    ${cs.balancedPutErMin}
  aggressiveCallErMin: ${cs.aggressiveCallErMin}
  aggressivePutErMin:  ${cs.aggressivePutErMin}

## Ghost trade win-rate data (CALL + PUT combined)
${fmtBuckets(overallBuckets)}

## CALL-only win-rate data
${fmtBuckets(callBuckets)}

## PUT-only win-rate data
${fmtBuckets(putBuckets)}

## Instructions
1. Identify the profitability cliff (lowest ER bucket where win-rate >= 50%) for CALL and PUT separately.
2. Use the cliff as the anchor for Sniper mode.
3. Set Balanced one bucket below Sniper, Aggressive one further below (or at 0.00 if already at the floor).
4. If CALL and PUT cliffs differ, set them asymmetrically — the data justifies this.
5. If insufficient data (win-rate null for most buckets), return current values unchanged and explain why.

Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON:
{
  "reasoning": "<2-3 sentence plain-English explanation for the admin>",
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
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
  const thinking = thinkMatch ? thinkMatch[1].trim() : "";
  const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { thinking, content };
}

function snapTo005(v: number): number {
  return Math.round(Math.round(v / 0.05) * 0.05 * 100) / 100;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(0.6, snapTo005(v)));
}

export async function POST(req: NextRequest) {
  // Rate limit check
  const ip = getClientIp(req);
  const rl = checkRateLimit(`nim-suggest:${ip}`, AI_RATE_LIMIT);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs) as NextResponse;

  if (!process.env.NVIDIA_NIM_API_KEY) {
    return NextResponse.json({ error: "NVIDIA_NIM_API_KEY is not configured on the server." }, { status: 500 });
  }

  let body: SuggestRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const completion = await nimClient.chat.completions.create({
      model: MODEL,
      // @ts-expect-error — NVIDIA NIM reasoning fields not in OpenAI SDK types
      reasoning_budget: 16384,
      chat_template_kwargs: { enable_thinking: true },
      max_tokens: 16384,
      temperature: 0.6,
      top_p: 0.95,
      messages: [
        {
          role: "user",
          content: buildPrompt(body),
        },
      ],
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    const { thinking, content } = extractThinkingAndContent(rawText);

    // Extract JSON from the content (model may wrap it in fences despite instructions)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Model did not return valid JSON.", raw: rawText }, { status: 502 });
    }

    let parsed: { reasoning: string; suggestions: Record<string, number> };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return NextResponse.json({ error: "Failed to parse model JSON output.", raw: rawText }, { status: 502 });
    }

    const s = parsed.suggestions;

    // Enforce constraints: sniper >= balanced >= aggressive, clamp to [0, 0.6]
    const aggressiveCall = clamp(s.aggressiveCallErMin ?? 0);
    const balancedCall   = clamp(Math.max(s.balancedCallErMin ?? 0, aggressiveCall));
    const sniperCall     = clamp(Math.max(s.sniperCallErMin ?? 0, balancedCall));

    const aggressivePut  = clamp(s.aggressivePutErMin ?? 0);
    const balancedPut    = clamp(Math.max(s.balancedPutErMin ?? 0, aggressivePut));
    const sniperPut      = clamp(Math.max(s.sniperPutErMin ?? 0, balancedPut));

    const result: SuggestResponse = {
      suggestions: {
        sniperCallErMin:     sniperCall,
        sniperPutErMin:      sniperPut,
        balancedCallErMin:   balancedCall,
        balancedPutErMin:    balancedPut,
        aggressiveCallErMin: aggressiveCall,
        aggressivePutErMin:  aggressivePut,
      },
      reasoning: parsed.reasoning ?? "",
      thinking,
    };

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `NVIDIA NIM API error: ${message}` }, { status: 502 });
  }
}
