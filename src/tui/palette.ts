export const palette = {
  canvas: "#101217",
  panel: "#171a21",
  panelRaised: "#1d212a",
  element: "#242934",
  elementHover: "#2a303c",
  text: "#d8dee9",
  textMuted: "#747d91",
  textSubtle: "#535b6b",
  border: "#303744",
  borderStrong: "#4b5568",
  accent: "#c69bf4",
  cyan: "#75e6d4",
  blue: "#82aaff",
  green: "#7bd88f",
  yellow: "#f2c55c",
  red: "#ff6b81",
  gold: "#ffd166",
  silver: "#c5cad3",
  bronze: "#d68b5f",
} as const;

export type SemanticStatus = "idle" | "busy" | "success" | "warning" | "error";

export function statusColor(status: SemanticStatus): string {
  switch (status) {
    case "busy":
      return palette.cyan;
    case "success":
      return palette.green;
    case "warning":
      return palette.yellow;
    case "error":
      return palette.red;
    default:
      return palette.textMuted;
  }
}
