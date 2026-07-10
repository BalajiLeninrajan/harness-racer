import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { HarnessId, ModelOption, ProviderInfo } from "../shared/types";
import { HarnessLogo, ModelLabLogo, modelLabName } from "./BrandLogo";

export interface RacerChoice {
  provider: ProviderInfo;
  model: ModelOption;
}

interface RacerPickerProps {
  providers: ProviderInfo[];
  harness: HarnessId;
  model: string;
  onChange: (choice: RacerChoice) => void;
}

function choiceKey(choice: RacerChoice): string {
  return `${choice.provider.id}\u0000${choice.model.id}`;
}

function choiceScore(choice: RacerChoice, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return choice.model.isDefault ? 100 : 0;
  const haystack = [
    choice.model.label,
    choice.model.id,
    choice.provider.name,
    choice.provider.command,
    modelLabName(choice.model.id, choice.provider.id),
  ].join(" ").toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.every((token) => haystack.includes(token))) return -1;
  if (choice.model.label.toLowerCase() === query || choice.model.id.toLowerCase() === query) return 1000;
  if (choice.model.label.toLowerCase().startsWith(query)) return 800;
  return 400;
}

export function RacerPicker({ providers, harness, model, onChange }: RacerPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [activeHarness, setActiveHarness] = useState<HarnessId>(harness);
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const choices = useMemo(
    () => providers.flatMap((provider) => provider.models
      .map((candidate, index) => ({ provider, model: candidate, index }))
      .sort((a, b) => Number(Boolean(b.model.isDefault)) - Number(Boolean(a.model.isDefault)) || a.index - b.index)
      .map(({ provider: itemProvider, model: itemModel }) => ({ provider: itemProvider, model: itemModel }))),
    [providers],
  );
  const filtered = useMemo(
    () => choices
      .map((choice, index) => ({ choice, index, score: choiceScore(choice, query) }))
      .filter((entry) => entry.choice.provider.id === activeHarness && entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.choice),
    [activeHarness, choices, query],
  );
  const selected = choices.find((choice) => choice.provider.id === harness && choice.model.id === model);
  const activeProvider = providers.find((provider) => provider.id === activeHarness);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveHarness(harness);
    setHighlighted(Math.max(0, choices.filter((choice) => choice.provider.id === harness).findIndex((choice) => choice.model.id === model)));
    window.requestAnimationFrame(() => searchRef.current?.focus());
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [choices, harness, model, open]);

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

  function choose(choice: RacerChoice) {
    onChange(choice);
    closeAndFocus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + direction + filtered.length) % Math.max(filtered.length, 1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlighted(event.key === "Home" ? 0 : Math.max(0, filtered.length - 1));
      return;
    }
    if (event.key === "Enter" && filtered[highlighted]) {
      event.preventDefault();
      choose(filtered[highlighted]);
    }
  }

  return (
    <div
      className={`racer-picker ${open ? "open" : ""}`}
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          closeAndFocus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="racer-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="racer-picker-logo" aria-hidden="true">
          <ModelLabLogo model={selected?.model.id ?? model} harness={selected?.provider.id ?? harness} size={22} />
        </span>
        <span className="racer-picker-copy">
          <strong>{selected?.model.label ?? model}</strong>
          <small>{selected ? `${modelLabName(selected.model.id, selected.provider.id)} · via ${selected.provider.name}` : "Choose a model"}</small>
        </span>
        <ChevronDown size={16} />
      </button>

      {open && (
        <div className="racer-picker-popover">
          <aside className="racer-picker-sidebar" aria-label="Harnesses">
            {providers.map((provider) => (
              <button
                type="button"
                className={provider.id === activeHarness ? "active" : ""}
                aria-pressed={provider.id === activeHarness}
                aria-label={provider.name}
                title={provider.name}
                key={provider.id}
                onClick={() => {
                  setActiveHarness(provider.id);
                  setQuery("");
                  setHighlighted(0);
                  window.requestAnimationFrame(() => searchRef.current?.focus());
                }}
              >
                <HarnessLogo harness={provider.id} size={19} />
              </button>
            ))}
          </aside>
          <div className="racer-picker-search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Search models"
              aria-label="Search models"
              aria-autocomplete="list"
              role="combobox"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={filtered[highlighted] ? `${listboxId}-${highlighted}` : undefined}
            />
          </div>
          <div className="racer-picker-options" id={listboxId} role="listbox" aria-label={`${activeProvider?.name ?? "Harness"} models`}>
            <div className="racer-picker-pane-label" role="presentation" aria-hidden="true">
              {activeProvider && <><HarnessLogo harness={activeProvider.id} size={14} /><strong>{activeProvider.name}</strong></>}
              <span>{filtered.length} model{filtered.length === 1 ? "" : "s"}</span>
            </div>
            {filtered.map((choice, index) => {
              const isSelected = choice.provider.id === harness && choice.model.id === model;
              return (
                <button
                  type="button"
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={-1}
                  className={`racer-picker-option ${index === highlighted ? "highlighted" : ""}`}
                  key={choiceKey(choice)}
                  ref={(element) => { optionRefs.current[index] = element; }}
                  onPointerMove={() => setHighlighted(index)}
                  onClick={() => choose(choice)}
                >
                  <span className="racer-option-logo" aria-hidden="true"><ModelLabLogo model={choice.model.id} harness={choice.provider.id} size={18} /></span>
                  <span><strong>{choice.model.label}</strong><small>{modelLabName(choice.model.id, choice.provider.id)} · {choice.model.id}</small></span>
                  {choice.model.isDefault && <em>DEFAULT</em>}
                  <Check className={isSelected ? "selected" : ""} size={15} />
                </button>
              );
            })}
            {!filtered.length && <div className="racer-picker-empty">No matching models</div>}
          </div>
        </div>
      )}
    </div>
  );
}
