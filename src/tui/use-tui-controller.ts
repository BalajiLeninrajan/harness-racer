import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Competitor, ProviderInfo, RunMode, SamplePreset } from "../shared/types.js";
import { getProviders } from "../server/app.js";
import { MAX_RACERS } from "./constants.js";
import {
  competitorsFromSelection,
  defaultSelection,
  filterRacerOptions,
  racerOptions,
  type RacerOption,
  type TuiRaceState,
} from "./model.js";
import type { Phase, PickerState } from "./types.js";
import { useRaceRunner } from "./use-race-runner.js";
import { useTuiInput } from "./use-tui-input.js";

const INITIAL_PICKER: PickerState = {
  slot: 0,
  providerCursor: 0,
  modelCursor: 0,
  focus: "models",
  query: "",
  searching: false,
};

export interface TuiController {
  phase: Phase;
  options: RacerOption[];
  selected: string[];
  lineupCursor: number;
  picker: PickerState;
  providers: ProviderInfo[];
  filteredPickerOptions: RacerOption[];
  competitors: Competitor[];
  configCursor: number;
  mode: RunMode;
  preset: SamplePreset;
  race: TuiRaceState;
  laneCursor: number;
  zoomed: boolean;
  notice?: string;
  error?: string;
}

export function useTuiController(columns: number, exit: () => void): TuiController {
  const [phase, setPhase] = useState<Phase>("loading");
  const [options, setOptions] = useState<RacerOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [lineupCursor, setLineupCursor] = useState(0);
  const [picker, setPicker] = useState<PickerState>(INITIAL_PICKER);
  const [configCursor, setConfigCursor] = useState(0);
  const [mode, setMode] = useState<RunMode>("parallel");
  const [preset, setPreset] = useState<SamplePreset>("standard");
  const [laneCursor, setLaneCursor] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const { race, start, cancel } = useRaceRunner();

  const providers = useMemo(
    () => Array.from(new Map(options.map((option) => [option.provider.id, option.provider])).values()),
    [options],
  );
  const activeProvider = providers[picker.providerCursor];
  const filteredPickerOptions = useMemo(
    () => activeProvider ? filterRacerOptions(options, activeProvider.id, picker.query) : [],
    [activeProvider, options, picker.query],
  );
  const competitors = useMemo(() => competitorsFromSelection(options, selected), [options, selected]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getProviders()
      .then((providerInfo) => {
        if (!active) return;
        const nextOptions = racerOptions(providerInfo);
        if (nextOptions.length < 2) throw new Error("CLI mode needs at least two available harness/model pairs.");
        setOptions(nextOptions);
        setSelected(defaultSelection(nextOptions));
        setPhase("lineup");
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("error");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const itemCount = selected.length + (selected.length < MAX_RACERS ? 1 : 0) + 1;
    setLineupCursor((current) => Math.min(current, Math.max(0, itemCount - 1)));
  }, [selected.length]);

  useEffect(() => {
    setPicker((current) => ({
      ...current,
      modelCursor: Math.min(current.modelCursor, Math.max(0, filteredPickerOptions.length - 1)),
    }));
  }, [filteredPickerOptions.length]);

  const openPicker = useCallback((slot: number) => {
    const currentOption = options.find((option) => option.key === selected[slot]);
    const providerCursor = currentOption
      ? Math.max(0, providers.findIndex((provider) => provider.id === currentOption.provider.id))
      : 0;
    const provider = providers[providerCursor];
    const providerOptions = provider ? filterRacerOptions(options, provider.id, "") : [];
    const modelCursor = currentOption ? Math.max(0, providerOptions.findIndex((option) => option.key === currentOption.key)) : 0;
    setPicker({ slot, providerCursor, modelCursor, focus: "models", query: "", searching: false });
    setNotice(undefined);
    setPhase("picker");
  }, [options, providers, selected]);

  const choosePickerOption = useCallback(() => {
    const option = filteredPickerOptions[picker.modelCursor];
    if (!option) return;
    setSelected((current) => picker.slot < current.length
      ? current.map((keyValue, index) => index === picker.slot ? option.key : keyValue)
      : [...current, option.key]);
    setLineupCursor(picker.slot);
    setPhase("lineup");
  }, [filteredPickerOptions, picker.modelCursor, picker.slot]);

  const continueToConfigure = useCallback(() => {
    if (selected.length >= 2) {
      setNotice(undefined);
      setPhase("configure");
    } else {
      setNotice("Add at least two racers.");
    }
  }, [selected.length]);

  const removeRacer = useCallback((index: number) => {
    setSelected((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setNotice(undefined);
  }, []);

  const updateConfigure = useCallback((state: { cursor: number; mode: RunMode; preset: SamplePreset }) => {
    setConfigCursor(state.cursor);
    setMode(state.mode);
    setPreset(state.preset);
  }, []);

  const startRace = useCallback(() => {
    setLaneCursor(0);
    setZoomed(false);
    setNotice(undefined);
    setPhase("running");
    void start({ type: "start", competitors, mode, samplePreset: preset }).then((outcome) => {
      if (!mounted.current || outcome.type === "stale") return;
      if (outcome.type === "cancelled") {
        setNotice("Race cancelled.");
        setPhase("configure");
      } else {
        setPhase("results");
      }
    });
  }, [competitors, mode, preset, start]);

  const cancelRace = useCallback(() => cancel(new Error("Race cancelled.")), [cancel]);
  const interruptAndExit = useCallback(() => {
    cancel(new Error("Interrupted."));
    exit();
  }, [cancel, exit]);

  useTuiInput(
    {
      phase,
      columns,
      picker,
      providerCount: providers.length,
      filteredModelCount: filteredPickerOptions.length,
      selectedCount: selected.length,
      lineupCursor,
      configCursor,
      mode,
      preset,
      laneCursor,
      zoomed,
      competitorCount: competitors.length,
    },
    {
      exit,
      interruptAndExit,
      setPhase,
      setPicker,
      choosePickerOption,
      openPicker,
      setNotice,
      setLineupCursor,
      removeRacer,
      continueToConfigure,
      updateConfigure,
      startRace,
      setLaneCursor,
      setZoomed,
      cancelRace,
    },
  );

  return {
    phase,
    options,
    selected,
    lineupCursor,
    picker,
    providers,
    filteredPickerOptions,
    competitors,
    configCursor,
    mode,
    preset,
    race,
    laneCursor,
    zoomed,
    notice,
    error,
  };
}
