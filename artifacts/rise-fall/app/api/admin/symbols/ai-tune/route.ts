import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";

const nimClient = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_NIM_API_KEY ?? "",
});

const MODEL = "nvidia/llama-3.1-nemotron-ultra-253b-v1";

// Rate limit: 10 requests per 5 minutes per IP — each call hits the paid NVIDIA NIM API.
const AI_RATE_LIMIT = { limit: 10, windowMs: 5 * 60 * 1000 };

export interface SymbolTuneInput {
  symbol: string;
  displayName: string;
  callEnabled: boolean;
  putEnabled: boolean;
  callTrades: number;
  callWinRate: number | null;
  callPnl: number | null;
  putTrades: number;
  putWinRate: number | null;
  putPnl: number | null;
}

export interface AiTuneRequest {
  symbols: SymbolTuneInput[];
  breakevenPct: number; // e.g. 52.9 for 85% payout
  minTrades: number;    // minimum trades required for a recommendation
}

export interface AiTuneProposal {
  symbol: string;
  displayName: string;
  direction: "CALL" | "PUT";
  action: "ENABLE" | "DISABLE";
  currentEnabled: boolean;
  suggestedEnabled: boolean;
  rationale: string;
  confidence: "high" | "medium" | "low";
  winRate: number | null;
  trades: number;
}

export interface AiTuneResponse {
  summary: string;
  proposals: AiTuneProposal[];
  thinking: string;
}

function fmtSymbolRow(s: SymbolTuneInput, breakevenPct: number): string {
  const fmtWr  = (wr: number | null) => wr != null ? `${wr.toFixed(1)}%` : "N/A";
  const fmtPnl = (p: number | null)  => p  != null ? (p >= 0 ? `+${p.toFixed(2)}` : p.toFixed(2)) : "N/A";
  const gap    = (wr: number | null) => wr != null ? ` (${(wr - breakevenPct).toFixed(1)}pp vs breakeven)` : "";
  return [
    `  ${s.displayName} [${s.symbol}]`,
    `    CALL: enabled=${s.callEnabled} | trades=${s.callTrades} | wr=${fmtWr(s.callWinRate)}${gap(s.callWinRate)} | pnl=${fmtPnl(s.callPnl)}`,
    `    PUT:  enabled=${s.putEnabled}  | trades=${s.putTrades}  | wr=${fmtWr(s.putWinRate)}${gap(s.putWinRate)}  | pnl=${fmtPnl(s.putPnl)}`,
  ].join("\n");
}

function buildPrompt(body: AiTuneRequest): string {
  const { symbols, breakevenPct, minTrades } = body;
  const table = symbols.map((s) => fmtSymbolRow(s, breakevenPct)).join("\n\n");

  return `You are a quantitative trading systems analyst reviewing per-symbol CALL/PUT performance for a binary-options system.

## Context
- Breakeven win-rate (at current payout): ${breakevenPct}%
- Minimum trades required before making a recommendation: ${minTrades}
- For each symbol, CALL and PUT are independently enabled/disabled in the system config.
- You may propose to DISABLE a direction (if it is currently ON and underperforming) or ENABLE a direction (if it is currently OFF and would benefit from being re-enabled based on data).

## Rules
1. Only propose changes for directions with ≥${minTrades} resolved trades.
2. DISABLE if: win-rate < ${(breakevenPct - 5).toFixed(1)}% AND pnl is negative AND trades ≥ ${minTrades}.
3. ENABLE if: direction is currently disabled AND win-rate ≥ ${(breakevenPct + 3).toFixed(1)}% AND trades ≥ ${minTrades} AND pnl is positive.
4. Confidence: "high" = win-rate < ${(breakevenPct - 10).toFixed(1)}% or > ${(breakevenPct + 10).toFixed(1)}% with ≥50 trades; "medium" = 10–25pp gap with ≥${minTrades} trades; "low" = borderline.
5. Do NOT propose a change if the direction is already in the correct state or if sample is too small.
6. Maximum 15 proposals. Order by urgency: high-confidence disables first, then enables, then medium.

## Per-symbol performance data
${table}

Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON:
{
  "summary": "<2-3 sentence plain-English overview: what stands out, how many changes, overall portfolio health>",
  "proposals": [
    {
      "symbol": "<raw symbol code e.g. 1HZ75V>",
      "direction": "<CALL|PUT>",
      "action": "<ENABLE|DISABLE>",
      "rationale": "<one sentence — cite win-rate, trade count, and pnl>",
      "confidence": "<high|medium|low>",
      "winRate": <number or null>,
      "trades": <number>
    }
  ]
}`;
}

function extractThinkingAndContent(raw: string): { thinking: string; content: string } {
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
  const thinking = thinkMatch ? thinkMatch[1].trim() : "";
  const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { thinking, content };
}

export async function POST(req: NextRequest) {
  // Rate limit check
  const ip = getClientIp(req);
  const rl = checkRateLimit(`nim-ai-tune:${ip}`, AI_RATE_LIMIT);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs) as NextResponse;

  if (!process.env.NVIDIA_NIM_API_KEY) {
    return NextResponse.json({ error: "NVIDIA_NIM_API_KEY is not configured on the server." }, { status: 500 });
  }

  let body: AiTuneRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const symbolsWithData = body.symbols.filter(
    (s) => (s.callTrades + s.putTrades) >= body.minTrades,
  );
  if (symbolsWithData.length === 0) {
    return NextResponse.json(
      { error: `No symbols have ≥${body.minTrades} resolved trades yet. Collect more data and retry.` },
      { status: 422 },
    );
  }

  try {
    const completion = await nimClient.chat.completions.create({
      model: MODEL,
      // @ts-expect-error — NVIDIA NIM chain-of-thought extra field
      thinking: { type: "enabled" },
      max_tokens: 6144,
      temperature: 0.6,
      top_p: 0.95,
      messages: [{ role: "user", content: buildPrompt(body) }],
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    const { thinking, content } = extractThinkingAndContent(rawText);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Model did not return valid JSON.", raw: rawText }, { status: 502 });
    }

    let parsed: {
      summary: string;
      proposals: Array<{
        symbol: string; direction: string; action: string;
        rationale: string; confidence: string;
        winRate: number | null; trades: number;
      }>;
    };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return NextResponse.json({ error: "Failed to parse model JSON output.", raw: rawText }, { status: 502 });
    }

    // Enrich proposals with current enabled state and display name
    const symbolMap = new Map(body.symbols.map((s) => [s.symbol, s]));
    const proposals: AiTuneProposal[] = (parsed.proposals ?? [])
      .slice(0, 15)
      .filter((p) => p.direction === "CALL" || p.direction === "PUT")
      .filter((p) => p.action === "ENABLE" || p.action === "DISABLE")
      .map((p): AiTuneProposal | null => {
        const src = symbolMap.get(p.symbol);
        if (!src) return null;
        const currentEnabled = p.direction === "CALL" ? src.callEnabled : src.putEnabled;
        const suggestedEnabled = p.action === "ENABLE";
        // Skip if already in desired state
        if (currentEnabled === suggestedEnabled) return null;
        return {
          symbol: p.symbol,
          displayName: src.displayName,
          direction: p.direction as "CALL" | "PUT",
          action: p.action as "ENABLE" | "DISABLE",
          currentEnabled,
          suggestedEnabled,
          rationale: p.rationale ?? "",
          confidence: (p.confidence ?? "low") as "high" | "medium" | "low",
          winRate: p.winRate ?? null,
          trades: p.trades ?? 0,
        };
      })
      .filter((p): p is AiTuneProposal => p !== null);

    const result: AiTuneResponse = {
      summary: parsed.summary ?? "",
      proposals,
      thinking,
    };

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `NVIDIA NIM API error: ${message}` }, { status: 502 });
  }
}
