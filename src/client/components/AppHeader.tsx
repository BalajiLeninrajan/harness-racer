import { Gauge, Info, LoaderCircle, Wifi, WifiOff } from "lucide-react";
import type { Phase, SocketState } from "../benchmark";

export type AppPage = "benchmark" | "about";

interface AppHeaderProps {
  page: AppPage;
  phase: Phase;
  socketState: SocketState;
  onHome: () => void;
  onToggleAbout: () => void;
}

export function AppHeader({ page, phase, socketState, onHome, onToggleAbout }: AppHeaderProps) {
  return (
    <header className="topbar">
      <button className="wordmark cn-fit" disabled={phase === "running"} onClick={onHome} aria-label="Harness Racer home">
        <span className="mark-solid" aria-hidden="true"><Gauge size={17} /></span>
        <em>harness</em>.racer
      </button>
      <div className={page === "about" ? "page-context cn-row cn-microlabel cn-text-mauve" : "stepper phase-track"} aria-label={page === "about" ? "Current page" : "Benchmark progress"}>
        {page === "about" ? <><Info size={13} /> Methodology</> : <>
          <span className={phase === "setup" ? "active" : "is-done"}><i>1</i>Racers</span>
          <span className={phase === "review" ? "active" : phase === "running" || phase === "results" ? "is-done" : ""}><i>2</i>Grid</span>
          <span className={phase === "running" ? "active" : phase === "results" ? "is-done" : ""}><i>3</i>Race</span>
          <span className={phase === "results" ? "active" : ""}><i>4</i>Results</span>
        </>}
      </div>
      <div className="cn-row cn-end">
        <button className="btn-flat about-button" aria-pressed={page === "about"} disabled={phase === "running"} onClick={onToggleAbout}><Info size={14} /> {page === "about" ? "Back to race" : "Methodology"}</button>
        <div className={`chip ${socketState === "open" ? "cn-text-green" : socketState === "closed" ? "cn-text-red" : ""}`} role="status">
          {socketState === "open" ? <Wifi size={14} /> : socketState === "connecting" ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}
          {socketState === "open" ? "engine ready" : socketState === "connecting" ? "waking up" : "engine offline"}
        </div>
      </div>
    </header>
  );
}
