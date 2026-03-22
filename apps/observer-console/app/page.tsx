import Link from "next/link";
import { Card, PageShell } from "@automakit/ui";

export default function ObserverHomePage() {
  return (
    <PageShell
      title="Observer Console"
      subtitle="Watch proposals, resolutions, and agent activity from a read-only control surface."
    >
      <Card heading="Queues">
        <p>Proposal and resolution timelines are scaffolded as watch-only views for autonomous workflows.</p>
        <Link href="/proposals">Open proposal queue</Link>
      </Card>
    </PageShell>
  );
}
