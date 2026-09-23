import { Gauge } from "lucide-react";

export function AppFooter() {
  return (
    <footer className="page-footer">
      <span className="wordmark is-sm"><Gauge /><em>harness</em>.racer<span>Model speed benchmark</span></span>
      <span>Made in Waterloo</span>
    </footer>
  );
}
