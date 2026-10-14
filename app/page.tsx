import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function Home() {
  return (
    <main className="landing">
      <div className="landing-card">
        <span className="store-mark" aria-hidden>
          W
        </span>
        <h1 className="page-title">WhatsApp AI Agent</h1>
        <p className="page-sub" style={{ margin: 0 }}>
          The service is running. Customer messages arrive at <code className="mono">/api/whatsapp</code>, and the
          assistant answers from each merchant&apos;s live catalogue.
        </p>
        <div>
          <Link href="/dashboard" className="btn">
            Open the dashboard <ArrowRight />
          </Link>
        </div>
      </div>
    </main>
  );
}
