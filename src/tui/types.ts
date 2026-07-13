export type Phase = "loading" | "lineup" | "picker" | "configure" | "running" | "results" | "error";

export type PickerFocus = "providers" | "models";

export interface PickerState {
  slot: number;
  providerCursor: number;
  modelCursor: number;
  focus: PickerFocus;
  query: string;
  searching: boolean;
}
