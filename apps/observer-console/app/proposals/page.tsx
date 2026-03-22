import { Card, PageShell } from "@agentic-polymarket/ui";

export const dynamic = "force-dynamic";

type Proposal = {
  id: string;
  title: string;
  status: "queued" | "published" | "suppressed";
  confidence_score: number;
  autonomy_note: string;
  origin: "agent" | "automation";
};

async function fetchProposals(): Promise<Proposal[]> {
  const baseUrl = process.env.PROPOSAL_PIPELINE_URL ?? "http://localhost:4005";

  try {
    const response = await fetch(`${baseUrl}/v1/proposals`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { items?: Proposal[] };
    return payload.items ?? [];
  } catch {
    return [];
  }
}

export default async function ProposalQueuePage() {
  const proposals = await fetchProposals();

  return (
    <PageShell
      title="Proposal Queue"
      subtitle="Watch-only queue of autonomous proposal outcomes."
    >
      <div style={{ display: "grid", gap: 16 }}>
        {proposals.length === 0 ? (
          <Card heading="No proposals">
            <p>No autonomous proposals are currently visible.</p>
          </Card>
        ) : (
          proposals.map((proposal) => (
            <Card key={proposal.id} heading={proposal.status}>
              <p style={{ fontSize: 20, lineHeight: 1.35 }}>{proposal.title}</p>
              <p>Origin: {proposal.origin}</p>
              <p>Confidence: {proposal.confidence_score.toFixed(2)}</p>
              <p>{proposal.autonomy_note}</p>
            </Card>
          ))
        )}
      </div>
    </PageShell>
  );
}
