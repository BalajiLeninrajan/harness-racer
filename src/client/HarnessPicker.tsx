import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { ProviderInfo } from "../shared/types";

interface HarnessPickerProps {
  providers: ProviderInfo[];
  value: string;
  renderIcon: (provider: ProviderInfo) => ReactNode;
  onChange: (provider: ProviderInfo) => void;
}

function providerScore(provider: ProviderInfo, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 0;
  const name = provider.name.toLowerCase();
  const command = provider.command.toLowerCase();
  if (!name.includes(query) && !command.includes(query)) return -1;
  if (name === query || command === query) return 100;
  if (name.startsWith(query)) return 80;
  if (command.startsWith(query)) return 70;
  return 50;
}

function providerReady(provider: ProviderInfo): boolean {
  return provider.authenticated !== false && provider.models.length > 0;
}

export function HarnessPicker({ providers, value, renderIcon, onChange }: HarnessPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = providers.find((provider) => provider.id === value) ?? providers[0];
  const filtered = useMemo(
    () => providers
      .map((provider, index) => ({ provider, index, score: providerScore(provider, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.provider),
    [providers, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlighted(Math.max(0, providers.findIndex((provider) => provider.id === value)));
    window.requestAnimationFrame(() => searchRef.current?.focus());
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, providers, value]);

  useEffect(() => {
    setHighlighted((current) => Math.min(current, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useEffect(() => {
    if (open) optionRefs.current[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function closeAndFocus() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(provider: ProviderInfo) {
    onChange(provider);
    closeAndFocus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => {
        if (!filtered.length) return 0;
        for (let offset = 1; offset <= filtered.length; offset += 1) {
          const candidate = (current + (direction * offset) + filtered.length) % filtered.length;
          if (providerReady(filtered[candidate])) return candidate;
        }
        return current;
      });
      return;
    }
    if (event.key === "Enter" && filtered[highlighted] && providerReady(filtered[highlighted])) {
      event.preventDefault();
      choose(filtered[highlighted]);
    }
  }

  if (!selected) return null;

  return (
    <div className={`model-picker harness-picker ${open ? "open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-provider-icon" aria-hidden="true">{renderIcon(selected)}</span>
        <span className="model-trigger-copy">
          <strong>{selected.name}</strong>
          <small>{selected.command}{selected.version ? ` · v${selected.version}` : ""}</small>
        </span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="model-picker-popover">
          <div className="model-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Search harnesses…"
              role="combobox"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={filtered[highlighted] ? `${listboxId}-${highlighted}` : undefined}
            />
          </div>
          <div className="model-picker-meta">
            <span>Local harnesses</span>
            <span>{filtered.length} detected</span>
          </div>
          <div className="model-picker-options" id={listboxId} role="listbox">
            {filtered.map((provider, index) => (
              <button
                type="button"
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={provider.id === value}
                className={`model-option ${index === highlighted ? "highlighted" : ""}`}
                disabled={!providerReady(provider)}
                key={provider.id}
                ref={(element) => { optionRefs.current[index] = element; }}
                onPointerMove={() => setHighlighted(index)}
                onClick={() => choose(provider)}
              >
                <div className="harness-picker-icon" aria-hidden="true">{renderIcon(provider)}</div>
                <span>
                  <strong>{provider.name}</strong>
                  <small>{providerReady(provider) ? `${provider.command}${provider.version ? ` · v${provider.version}` : ""}` : provider.message ?? "Sign-in required"}</small>
                </span>
                <Check className={provider.id === value ? "selected" : ""} size={15} />
              </button>
            ))}
            {!filtered.length && <div className="model-picker-empty">No installed harnesses match “{query}”</div>}
          </div>
        </div>
      )}
    </div>
  );
}
