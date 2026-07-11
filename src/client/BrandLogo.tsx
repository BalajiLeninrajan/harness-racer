import anthropicLogo from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import codexLogo from "@lobehub/icons-static-svg/icons/codex.svg?url";
import cursorLogo from "@lobehub/icons-static-svg/icons/cursor.svg?url";
import deepseekLogo from "@lobehub/icons-static-svg/icons/deepseek.svg?url";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini.svg?url";
import grokLogo from "@lobehub/icons-static-svg/icons/grok.svg?url";
import metaLogo from "@lobehub/icons-static-svg/icons/meta.svg?url";
import mistralLogo from "@lobehub/icons-static-svg/icons/mistral.svg?url";
import openaiLogo from "@lobehub/icons-static-svg/icons/openai.svg?url";
import opencodeLogo from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import qwenLogo from "@lobehub/icons-static-svg/icons/qwen.svg?url";
import type { HarnessId } from "../shared/types";

type LogoId = "anthropic" | "codex" | "cursor" | "deepseek" | "gemini" | "grok" | "meta" | "mistral" | "openai" | "opencode" | "qwen";

const LOGOS: Record<LogoId, { label: string; src: string }> = {
  anthropic: { label: "Anthropic", src: anthropicLogo },
  codex: { label: "Codex", src: codexLogo },
  cursor: { label: "Cursor", src: cursorLogo },
  deepseek: { label: "DeepSeek", src: deepseekLogo },
  gemini: { label: "Google", src: geminiLogo },
  grok: { label: "xAI", src: grokLogo },
  meta: { label: "Meta", src: metaLogo },
  mistral: { label: "Mistral", src: mistralLogo },
  openai: { label: "OpenAI", src: openaiLogo },
  opencode: { label: "OpenCode", src: opencodeLogo },
  qwen: { label: "Alibaba", src: qwenLogo },
};

const HARNESS_LOGOS: Record<HarnessId, LogoId> = {
  claudeAgent: "anthropic",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
};

export function modelLab(model: string, harness: HarnessId): LogoId {
  const normalized = model.toLowerCase();
  const providerPrefix = normalized.includes("/") ? normalized.split("/", 1)[0] : "";
  if (normalized.includes("claude") || providerPrefix === "anthropic") return "anthropic";
  if (normalized.includes("gemini") || normalized.includes("gemma") || providerPrefix === "google") return "gemini";
  if (normalized.includes("grok") || providerPrefix === "xai") return "grok";
  if (normalized.includes("deepseek") || providerPrefix === "deepseek") return "deepseek";
  if (normalized.includes("mistral") || normalized.includes("codestral") || providerPrefix === "mistral") return "mistral";
  if (normalized.includes("qwen") || providerPrefix === "alibaba") return "qwen";
  if (normalized.includes("llama") || providerPrefix === "meta") return "meta";
  if (/\b(gpt|o[134](?:\b|-)|chatgpt|openai|codex)/.test(normalized) || providerPrefix === "openai") return "openai";
  return HARNESS_LOGOS[harness];
}

export function modelLabName(model: string, harness: HarnessId): string {
  return LOGOS[modelLab(model, harness)].label;
}

function Logo({ id, size = 18 }: { id: LogoId; size?: number }) {
  const logo = LOGOS[id];
  return (
    <img
      className={`brand-logo brand-logo-${id}`}
      src={logo.src}
      width={size}
      height={size}
      title={logo.label}
      alt={logo.label}
    />
  );
}

export function ModelLabLogo({ model, harness, size }: { model: string; harness: HarnessId; size?: number }) {
  return <Logo id={modelLab(model, harness)} size={size} />;
}

export function HarnessLogo({ harness, size }: { harness: HarnessId; size?: number }) {
  return <Logo id={HARNESS_LOGOS[harness]} size={size} />;
}
