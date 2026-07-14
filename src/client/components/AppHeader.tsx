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
      <button className="brand" disabled={phase === "running"} onClick={onHome} aria-label="Harness Racer home">
        <span className="brand-icon"><Gauge size={19} /></span>
        <span><b>harness</b>.racer</span>
      </button>
      <div className={page === "about" ? "page-context" : "phase-track"} aria-label={page === "about" ? "Current page" : "Benchmark progress"}>
        {page === "about" ? <><Info size={13} /> Methodology</> : <>
          <span className={phase === "setup" ? "active" : "done"}><i>1</i>Racers</span>
          <b />
          <span className={phase === "review" ? "active" : phase === "running" || phase === "results" ? "done" : ""}><i>2</i>Grid</span>
          <b />
          <span className={phase === "running" ? "active" : phase === "results" ? "done" : ""}><i>3</i>Race</span>
          <b />
          <span className={phase === "results" ? "active" : ""}><i>4</i>Results</span>
        </>}
      </div>
      <div className="topbar-actions">
        <button className={`about-button ${page === "about" ? "active" : ""}`} disabled={phase === "running"} onClick={onToggleAbout}><Info size={14} /> {page === "about" ? "Back to race" : "Methodology"}</button>
        <div className={`connection connection-${socketState}`} role="status">
          {socketState === "open" ? <Wifi size={14} /> : socketState === "connecting" ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}
          {socketState === "open" ? "engine ready" : socketState === "connecting" ? "waking up" : "engine offline"}
        </div>
      </div>
    </header>
  );
}
