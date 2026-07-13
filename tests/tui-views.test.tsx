import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import type { Competitor, ProviderInfo } from "../src/shared/types.js";
import { ConfigureView, LineupView, PickerView, ResultsView, RunningView } from "../src/tui/app.js";
import { emptyRaceState, filterRacerOptions, racerOptions, type TuiRaceState } from "../src/tui/model.js";

const stripAnsi = (value: string) => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
const renderedLineCount = (value: string) => stripAnsi(value).trim().split("\n").length;

function fixtures() {
  const providers: ProviderInfo[] = [
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      installed: true,
      authenticated: true,
      models: Array.from({ length: 15 }, (_, index) => ({
        id: `gpt-5-${index + 1}`,
        label: `GPT-5.${index + 1}`,
        isDefault: index === 4,
      })),
    },
    {
      id: "cursor",
      name: "Cursor",
      command: "cursor-agent",
      installed: true,
      authenticated: true,
      models: [{ id: "cursor-grok-4.5", label: "Cursor Grok 4.5", isDefault: true }],
    },
    {
      id: "claudeAgent",
      name: "Claude",
      command: "claude",
      installed: true,
      authenticated: true,
      models: [{ id: "opus", label: "Claude Opus", isDefault: true }],
    },
  ];
  const options = racerOptions(providers);
  const selected = ["codex:gpt-5-5", "cursor:cursor-grok-4.5", "claudeAgent:opus"];
  const competitors: Competitor[] = selected.map((key, index) => {
    const option = options.find((candidate) => candidate.key === key)!;
    return {
      id: `racer-${index}`,
      harness: option.provider.id,
      model: option.model.id,
      label: option.model.label,
      color: ["#cba6f7", "#94e2d5", "#f9e2af"][index],
    };
  });
  return { providers, options, selected, competitors };
}

describe("terminal UI views", () => {
  it("shows an editable lineup list and both actions", () => {
    const { options, selected } = fixtures();
    const output = stripAnsi(renderToString(
      <LineupView options={options} selected={selected} cursor={0} />,
      { columns: 100 },
    ));

    expect(output).toContain("● 01 GPT-5.5");
    expect(output).toContain("› ● 01 GPT-5.5");
    expect(output).toContain("via Codex");
    expect(output).toContain("● 02 Cursor Grok 4.5");
    expect(output).toContain("＋ Add racer");
    expect(output).toContain("Continue to starting grid");
    expect(output).not.toMatch(/[│║]/);
  });

  it("renders provider and searchable model tiers with inventory position", () => {
    const { providers, options, selected } = fixtures();
    const filtered = filterRacerOptions(options, "codex", "gpt-5");
    const output = stripAnsi(renderToString(
      <PickerView
        providers={providers}
        options={options}
        filtered={filtered}
        selected={selected}
        state={{ slot: 0, providerCursor: 0, modelCursor: 7, focus: "models", query: "gpt-5", searching: true }}
        columns={110}
        rows={24}
      />,
      { columns: 110 },
    ));

    expect(output).toContain("HARNESS");
    expect(output).toContain("Codex");
    expect(output).toContain("Cursor");
    expect(output).toContain("/ gpt-5▌");
    expect(output).toMatch(/\d+–\d+ \/ 15/);
    expect(output).not.toContain("●");
  });

  it("shows every grid option instead of only the active value", () => {
    const { competitors } = fixtures();
    const output = stripAnsi(renderToString(
      <ConfigureView competitors={competitors} cursor={3} mode="parallel" preset="standard" columns={100} />,
      { columns: 100 },
    ));

    for (const label of ["Parallel", "Sequential", "Quick", "Standard", "Thorough", "Start race"]) {
      expect(output).toContain(label);
    }
    expect(output).toContain("enter ↵");
    expect(output).not.toContain("enter anywhere");
    expect(output).toContain("space select  enter start race");
  });

  it("renders wide races as full-height output panes", () => {
    const { competitors } = fixtures();
    const outputText = Array.from({ length: 18 }, (_, index) => `stream line ${index + 1}`).join("\n");
    const race: TuiRaceState = {
      ...emptyRaceState(),
      totalRuns: 6,
      completedRuns: 1,
      lanes: Object.fromEntries(competitors.map((competitor) => [competitor.id, {
        status: "running" as const,
        workload: "prose" as const,
        sample: 1,
        warmup: false,
        output: outputText,
        firstOutputMs: 940,
        visibleTokensPerSecond: 84.1,
        completedRuns: 0,
      }])),
    };
    const output = stripAnsi(renderToString(
      <RunningView competitors={competitors} race={race} spinner="⠋" columns={132} rows={24} cursor={0} zoomed={false} pulse={true} />,
      { columns: 132 },
    ));

    expect(output).toContain("stream line 18");
    expect(output.split("\n").length).toBeGreaterThan(15);
    expect(output).toContain("enter/z zoom");
    expect(output).toContain("● GPT-5.5");

    const dimmedPulse = stripAnsi(renderToString(
      <RunningView competitors={competitors} race={race} spinner="⠋" columns={132} rows={24} cursor={0} zoomed={false} pulse={false} />,
      { columns: 132 },
    ));
    expect(dimmedPulse).toContain("○ GPT-5.5");
    expect(output.replaceAll("●", "○")).toBe(dimmedPulse);
  });

  it("spaces result columns independently", () => {
    const { competitors } = fixtures();
    const race: TuiRaceState = {
      ...emptyRaceState(),
      summary: competitors.map((competitor, index) => ({
        competitor,
        measuredRuns: 2,
        validRuns: 2,
        anomalousRuns: 0,
        disqualified: false,
        promptToFirstOutputMs: 1_300 + index,
        coldStartToFirstOutputMs: 1_500 + index,
        promptToFinishMs: 5_250 + index,
        visibleTokensPerSecond: 83.9 + index,
        finishRank: index + 1,
        crowns: index === 0 ? ["finish", "firstOutput", "coldStart", "visibleSpeed"] : [],
      })),
    };
    const output = stripAnsi(renderToString(<ResultsView race={race} columns={100} />, { columns: 100 }));

    expect(output).toContain("GPT-5.5 · codex");
    expect(output).toContain("★ WINNER");
    expect(output).toContain("FULL CLASSIFICATION");
    expect(output).toContain("Cold");
    expect(output).toContain("1.30s ★");
    expect(output).not.toContain("codex1.30s");
  });

  it("keeps every static screen within a compact terminal", () => {
    const { competitors, options, providers, selected } = fixtures();
    const filtered = filterRacerOptions(options, "codex", "gpt-5");
    const race: TuiRaceState = {
      ...emptyRaceState(),
      summary: competitors.map((competitor, index) => ({
        competitor,
        measuredRuns: 2,
        validRuns: 2,
        anomalousRuns: 0,
        disqualified: false,
        promptToFirstOutputMs: 1_300 + index,
        coldStartToFirstOutputMs: 1_500 + index,
        promptToFinishMs: 5_250 + index,
        visibleTokensPerSecond: 83.9 + index,
        finishRank: index + 1,
        crowns: [],
      })),
    };
    const views = [
      renderToString(<LineupView options={options} selected={selected} cursor={0} columns={60} rows={16} />, { columns: 60 }),
      renderToString(
        <PickerView
          providers={providers}
          options={options}
          filtered={filtered}
          selected={selected}
          state={{ slot: 0, providerCursor: 0, modelCursor: 7, focus: "models", query: "", searching: false }}
          columns={60}
          rows={16}
        />,
        { columns: 60 },
      ),
      renderToString(<ConfigureView competitors={competitors} cursor={3} mode="parallel" preset="standard" columns={60} rows={16} />, { columns: 60 }),
      renderToString(<ResultsView race={race} columns={60} rows={16} />, { columns: 60 }),
    ];

    for (const view of views) expect(renderedLineCount(view)).toBeLessThanOrEqual(16);
    expect(stripAnsi(views[2])).toContain("Thorough");
    expect(stripAnsi(views[3])).toContain("#3");
  });
});
