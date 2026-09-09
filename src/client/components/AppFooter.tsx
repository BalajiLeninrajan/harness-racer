import { Gauge } from "lucide-react";

export function AppFooter() {
  return (
    <footer className="footer-neu">
      <span className="footer-brand"><Gauge /><strong className="cn-name"><em>harness</em>.racer</strong><span>Model speed benchmark</span></span>
      <span>Made with 💜 in Waterloo</span>
    </footer>
  );
}
