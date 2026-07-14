import { Gauge } from "lucide-react";

export function AppFooter() {
  return (
    <footer>
      <div className="footer-brand"><Gauge size={16} /><strong><b>harness</b>.racer</strong><span>Model speed benchmark</span></div>
      <span className="footer-note">Made with 💜 in Waterloo</span>
    </footer>
  );
}
