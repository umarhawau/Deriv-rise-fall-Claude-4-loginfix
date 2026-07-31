"use server";

import OpenAI from "openai";

const nimClient = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_NIM_API_KEY ?? "",
});

const MODEL = "nvidia/nemotron-3-super-120b-a12b";

export interface BreakdownRow {
  label: string;
  wins: number;
  losses: number;
  total: number;
  lossRate: number;
}

export interface LossPatternPayload {
  overall: { resolved: number; wins: number; losses: number; lossRate: number };
  byHour:      BreakdownRow[];
  bySymbol:    BreakdownRow[];
  byMode:      BreakdownRow[];
  byDirection: BreakdownRow[];
  byDuration:  BreakdownRow[];
  byErBucket:  BreakdownRow[];
  byNoise:     BreakdownRow[];
}

export interface LossFinding {
  factor: string;
  label: string;
  finding: string;
  lossRate: number;
  baselineLossRate: number;
  severity: "high" | "medium" | "low";
}

export interface LossPatternResponse {
  summary: string;
  findings: LossFinding[];
  thinking: string;
}

type ActionResult<T> = { success: true; data: T } | { success: false; error: string };

function fmtBreakdown(rows: BreakdownRow[], maxRows = 10): string {
  return rows
    .slice(0, maxRows)
    .map((r) => {
      const lr = r.total > 0 ? r.lossRate.toFixed(1) : "N/A";
      return `  ${r.label.padEnd(18)} | total: ${String(r.total).padStart(5)} | ${r.wins}W / ${r.losses}L | loss-rate: ${lr}%`;
    })
    .join("\n");
}

function buildPrompt(body: LossPatternPayload): string {
  const { overall } = body;
  return `You are a quantitative trading analyst reviewing loss patterns in a binary-options system.

## Overall performance (resolved trades only)
  Total resolved: ${overall.resolved}
  Wins: ${overall.wins} | Losses: ${overall.losses}
  Baseline loss rate: ${overall.lossRate.toFixed(1)}%

## Loss rate by time of day (UTC, 4-hour windows)
${fmtBreakdown(body.byHour)}

## Loss rate by symbol (sorted by loss rate, min 5 trades)
${fmtBreakdown(body.bySymbol, 15)}

## Loss rate by trading mode
${fmtBreakdown(body.byMode)}

## Loss rate by direction (CALL vs PUT)
${fmtBreakdown(body.byDirection)}

## Loss rate by trade duration
${fmtBreakdown(body.byDuration)}

## Loss rate by ER-at-entry bucket
${fmtBreakdown(body.byErBucket)}

## Loss rate by noise-at-entry bucket
${fmtBreakdown(body.byNoise)}

## Your task
Identify patterns where loss rate is meaningfully above the ${overall.lossRate.toFixed(1)}% baseline. Focus on actionable insights. Ignore factors with fewer than 5 trades. A finding is "high" severity if loss rate is >15pp above baseline, "medium" if >8pp above baseline, "low" otherwise.

Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON:
{
  "summary": "<2-3 sentence plain-English overview>",
  "findings": [
    {
      "factor": "<dimension name>",
      "label": "<specific value>",
      "finding": "<one sentence describing the pattern>",
      "lossRate": <number>,
      "baselineLossRate": <number>,
      "severity": "<high|medium|low>"
    }
  ]
}
Only include findings where data supports a real pattern. Order by severity desc, then lossRate desc. Maximum 10 findings.`;
}

function extractThinkingAndContent(raw: string): { thinking: string; content: string } {
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
  const thinking = thinkMatch ? thinkMatch[1].trim() : "";
  const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { thinking, content };
}

export async function analyzeLossPatterns(
  body: LossPatternPayload,
): Promise<ActionResult<LossPatternResponse>> {
  if (!process.env.NVIDIA_NIM_API_KEY) {
    return { success: false, error: "NVIDIA_NIM_API_KEY is not configured on the server." };
  }
  if (body.overall.resolved < 10) {
    return { success: false, error: "Not enough resolved trades to analyse (minimum 10)." };
  }
  try {
    const completion = await nimClient.chat.completions.create({
      model: MODEL,
      // @ts-expect-error — NVIDIA NIM reasoning-mode extra fields
      reasoning_budget: 16384,
      chat_template_kwargs: { enable_thinking: true },
      max_tokens: 6144,
      temperature: 1.0,
      top_p: 0.95,
      messages: [{ role: "user", content: buildPrompt(body) }],
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    const { thinking, content } = extractThinkingAndContent(rawText);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { success: false, error: "Model did not return valid JSON." };

    let parsed: { summary: string; findings: LossFinding[] };
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { return { success: false, error: "Failed to parse model JSON output." }; }

    return {
      success: true,
      data: {
        summary: parsed.summary ?? "",
        findings: (parsed.findings ?? []).slice(0, 10),
        thinking,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `NVIDIA NIM API error: ${message}` };
  }
}
