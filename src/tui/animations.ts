import { useAnimation } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useSpinner(active: boolean): string {
  const { frame } = useAnimation({ interval: 80, isActive: active });
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
}

export function usePulse(active: boolean): boolean {
  const { frame } = useAnimation({ interval: 800, isActive: active });
  return !active || frame % 2 === 0;
}
