import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { ModelOption } from "../shared/types";

interface ModelPickerProps {
  models: ModelOption[];
  value: string;
  providerName: string;
  providerIcon: ReactNode;
  onChange: (model: ModelOption) => void;
}

function scoreModel(model: ModelOption, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return model.isDefault ? 100 : 0;
  const label = model.label.toLowerCase();
  const id = model.id.toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.every((token) => label.includes(token) || id.includes(token))) return -1;
  if (label === query || id === query) return 1000;
  if (label.startsWith(query)) return 800;
  if (id.startsWith(query)) return 700;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return 600;
  return 400 - Math.min(label.indexOf(query), id.indexOf(query));
}

export function ModelPicker({ models, value, providerName, providerIcon, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = models.find((model) => model.id === value) ?? { id: value, label: value };
  const filtered = useMemo(
    () => models
      .map((model, index) => ({ model, index, score: scoreModel(model, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.model),
    [models, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const ordered = [...models].sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
    const selectedIndex = Math.max(0, ordered.findIndex((model) => model.id === value));
    setHighlighted(selectedIndex);
    window.requestAnimationFrame(() => searchRef.current?.focus());
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [models, open, value]);

  useEffect(() => {
    setHighlighted((current) => Math.min(current, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useEffect(() => {
    if (open) optionRefs.current[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function choose(model: ModelOption) {
    onChange(model);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + direction + filtered.length) % Math.max(filtered.length, 1));
      return;
    }
    if (event.key === "Enter" && filtered[highlighted]) {
      event.preventDefault();
      choose(filtered[highlighted]);
    }
  }

  return (
    <div className={`model-picker ${open ? "open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-provider-icon" aria-hidden="true">{providerIcon}</span>
        <span className="model-trigger-copy">
          <strong>{selected.label}</strong>
          <small>{selected.id}</small>
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
              placeholder="Search models…"
              role="combobox"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={filtered[highlighted] ? `${listboxId}-${highlighted}` : undefined}
            />
          </div>
          <div className="model-picker-meta">
            <span>{providerIcon}{providerName}</span>
            <span>{filtered.length} model{filtered.length === 1 ? "" : "s"}</span>
          </div>
          <div className="model-picker-options" id={listboxId} role="listbox">
            {filtered.map((model, index) => (
              <button
                type="button"
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={model.id === value}
                className={`model-option ${index === highlighted ? "highlighted" : ""}`}
                key={model.id}
                ref={(element) => { optionRefs.current[index] = element; }}
                onPointerMove={() => setHighlighted(index)}
                onClick={() => choose(model)}
              >
                <span>
                  <strong>{model.label}</strong>
                  <small>{model.id}</small>
                </span>
                {model.isDefault && <em>DEFAULT</em>}
                <Check className={model.id === value ? "selected" : ""} size={15} />
              </button>
            ))}
            {!filtered.length && (
              <div className="model-picker-empty">No models match “{query}”</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
