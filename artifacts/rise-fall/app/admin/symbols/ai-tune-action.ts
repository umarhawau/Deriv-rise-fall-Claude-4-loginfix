"use server";

import OpenAI from "openai";

const nimClient = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_NIM_API_KEY ?? "",
});

const MODEL = "nvidia/nemotron-3-super-120b-a12b";

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

export interface AiTuneRequest {
  symbols: SymbolTuneInput[];
  breakevenPct: number;
  minTrades: number;
}

type ActionResult<T> = { success: true; data: T } | { success: false; error: string };

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
- Breakeven win-rate: ${breakevenPct}%
- Minimum trades required before making a recommendation: ${minTrades}
- You may propose to DISABLE a direction (currently ON, underperforming) or ENABLE a direction (currently OFF, data now supports it).

## Rules
1. Only propose changes for directions with ≥${minTrades} resolved trades.
2. DISABLE if: win-rate < ${(breakevenPct - 5).toFixed(1)}% AND pnl is negative AND trades ≥ ${minTrades}.
3. ENABLE if: direction is currently disabled AND win-rate ≥ ${(breakevenPct + 3).toFixed(1)}% AND trades ≥ ${minTrades} AND pnl is positive.
4. Confidence: "high" = >10pp gap with ≥50 trades; "medium" = 5–10pp gap with ≥${minTrades} trades; "low" = borderline.
5. Do NOT propose a no-op (change to same state). Maximum 15 proposals.

## Per-symbol performance data
${table}

Respond ONLY with valid JSON — no markdown fences:
{
  "summary": "<2-3 sentence overview>",
  "proposals": [
    {
      "symbol": "<raw symbol code>",
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

export async function runAiTune(
  body: AiTuneRequest,
): Promise<ActionResult<AiTuneResponse>> {
  if (!process.env.NVIDIA_NIM_API_KEY) {
    return { success: false, error: "NVIDIA_NIM_API_KEY is not configured on the server." };
  }

  const symbolsWithData = body.symbols.filter(
    (s) => s.callTrades >= body.minTrades || s.putTrades >= body.minTrades,
  );
  if (symbolsWithData.length === 0) {
    return {
      success: false,
      error: `No symbols have ≥${body.minTrades} resolved trades yet. Collect more data and retry.`,
    };
  }

  try {
    const completion = await nimClient.chat.completions.create({
      model: MODEL,
      // @ts-expect-error — NVIDIA NIM reasoning fields not in OpenAI SDK types
      reasoning_budget: 16384,
      chat_template_kwargs: { enable_thinking: true },
      max_tokens: 16384,
      temperature: 1.0,
      top_p: 0.95,
      messages: [{ role: "user", content: buildPrompt(body) }],
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    const { thinking, content } = extractThinkingAndContent(rawText);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { success: false, error: "Model did not return valid JSON." };

    let parsed: {
      summary: string;
      proposals: Array<{
        symbol: string; direction: string; action: string;
        rationale: string; confidence: string;
        winRate: number | null; trades: number;
      }>;
    };
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { return { success: false, error: "Failed to parse model JSON output." }; }

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

    return {
      success: true,
      data: { summary: parsed.summary ?? "", proposals, thinking },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `NVIDIA NIM API error: ${message}` };
  }
}
