import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

type ManagedProcess = {
  name: string;
  child: ReturnType<typeof spawn>;
  command: string;
  args: string[];
  extraEnv: Record<string, string>;
  cwd: string;
};

function startProcess(
  name: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd = process.cwd(),
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  return { name, child, command, args, extraEnv, cwd };
}

async function waitForJson(url: string, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {}

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForText(url: string, expected: string, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        if (text.includes(expected)) {
          return;
        }
      }
    } catch {}

    await delay(500);
  }

  throw new Error(`Timed out waiting for text ${expected} at ${url}`);
}

async function waitForCondition(
  label: string,
  predicate: () => Promise<boolean>,
  attempts = 50,
) {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) {
      return;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for condition: ${label}`);
}

async function reservePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForDatabase(databaseUrl: string, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await delay(1000);
    }
  }

  throw new Error(`Timed out waiting for Postgres at ${databaseUrl}`);
}

async function stopProcess(process: ManagedProcess) {
  await new Promise<void>((resolve) => {
    if (process.child.exitCode !== null) {
      resolve();
      return;
    }

    process.child.once("exit", () => resolve());
    process.child.kill("SIGTERM");
    setTimeout(() => {
      if (process.child.exitCode === null) {
        process.child.kill("SIGKILL");
      }
    }, 1000);
  });
}

function restartProcess(processes: ManagedProcess[], process: ManagedProcess) {
  const index = processes.indexOf(process);
  const restarted = startProcess(process.name, process.command, process.args, process.extraEnv, process.cwd);
  if (index >= 0) {
    processes[index] = restarted;
  } else {
    processes.push(restarted);
  }
  return restarted;
}

async function main() {
  const databasePort = await reservePort();
  const feedPort = await reservePort();
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "agentic-polymarket-live-test-"));
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${databasePort}/postgres`;
  const repoRoot = process.cwd();
  const nextBin = path.join(repoRoot, "node_modules", ".pnpm", "node_modules", ".bin", "next");
  const pgliteServerBin = path.join(repoRoot, "node_modules", ".bin", "pglite-server");
  const signalPayload = {
    items: [
      {
        sourceId: "btc-price-jun-2026",
        sourceType: "calendar",
        category: "crypto",
        headline: "Will BTC trade above $100k by June 30, 2026?",
        closeTime: "2026-06-30T23:59:59Z",
        resolutionCriteria:
          "Resolve YES if BTC spot trades above 100,000 USD on or before the close time.",
        sourceOfTruthUrl: "https://www.cmegroup.com/",
        resolutionKind: "price_threshold",
        resolutionMetadata: {
          kind: "price_threshold",
          operator: "gt",
          threshold: 100000,
        },
      },
      {
        sourceId: "fed-cut-jul-2026",
        sourceType: "calendar",
        category: "macro",
        headline: "Will the Fed cut rates before July 31, 2026?",
        closeTime: "2026-07-31T23:59:59Z",
        resolutionCriteria:
          "Resolve YES if the federal funds target range is lowered before the close time.",
        sourceOfTruthUrl: "https://www.federalreserve.gov/",
        resolutionKind: "rate_decision",
        resolutionMetadata: {
          kind: "rate_decision",
          direction: "cut",
        },
      },
    ],
  };

  const feedServer = http.createServer((request, response) => {
    if (request.url === "/signals") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(signalPayload));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    feedServer.listen(feedPort, "127.0.0.1", () => resolve());
  });

  const processes: ManagedProcess[] = [];
  try {
    processes.push(
      startProcess(
        "database",
        pgliteServerBin,
        [
          "--db",
          databaseDirectory,
          "--host",
          "127.0.0.1",
          "--port",
          String(databasePort),
          "--max-connections",
          "16",
        ],
      ),
    );
    await waitForDatabase(databaseUrl);

    processes.push(
      startProcess(
        "portfolio-service",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
        },
        path.join(repoRoot, "services", "portfolio-service"),
      ),
    );
    processes.push(
      startProcess(
        "market-service",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
        },
        path.join(repoRoot, "services", "market-service"),
      ),
    );
    processes.push(
      startProcess(
        "proposal-pipeline",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
        },
        path.join(repoRoot, "services", "proposal-pipeline"),
      ),
    );
    processes.push(
      startProcess(
        "resolution-service",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
          PORTFOLIO_SERVICE_URL: "http://127.0.0.1:4004",
        },
        path.join(repoRoot, "services", "resolution-service"),
      ),
    );
    processes.push(
      startProcess(
        "market-creator",
        process.execPath,
        ["dist/index.js"],
        {
          PROPOSAL_PIPELINE_URL: "http://127.0.0.1:4005",
          MARKET_CREATOR_SIGNAL_FEED_URLS: `http://127.0.0.1:${feedPort}/signals`,
          MARKET_CREATOR_INTERVAL_MS: "1000",
        },
        path.join(repoRoot, "services", "market-creator"),
      ),
    );
    processes.push(
      startProcess(
        "web",
        nextBin,
        ["start", "-p", "3000"],
        {
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
        },
        path.join(repoRoot, "apps", "web"),
      ),
    );
    processes.push(
      startProcess(
        "observer-console",
        nextBin,
        ["start", "-p", "3001"],
        {
          PROPOSAL_PIPELINE_URL: "http://127.0.0.1:4005",
        },
        path.join(repoRoot, "apps", "observer-console"),
      ),
    );

    await waitForJson("http://127.0.0.1:4003/health");
    await waitForJson("http://127.0.0.1:4004/health");
    await waitForJson("http://127.0.0.1:4005/health");
    await waitForJson("http://127.0.0.1:4006/health");
    await waitForText("http://127.0.0.1:3000", "Markets");
    await waitForText("http://127.0.0.1:3001/proposals", "Proposal Queue");

    await waitForCondition("published proposals", async () => {
      const proposals = (await waitForJson("http://127.0.0.1:4005/v1/proposals")) as {
        items: Array<{ status: string }>;
      };
      return proposals.items.length >= 2 && proposals.items.every((proposal) => proposal.status === "published");
    });

    const proposals = (await waitForJson("http://127.0.0.1:4005/v1/proposals")) as {
      items: Array<{ title: string; status: string; linked_market_id?: string }>;
    };

    await waitForCondition("published markets", async () => {
      const markets = (await waitForJson("http://127.0.0.1:4003/v1/markets")) as {
        items: Array<{ id: string; title: string }>;
      };
      return markets.items.length >= 2;
    });

    const markets = (await waitForJson("http://127.0.0.1:4003/v1/markets")) as {
      items: Array<{ id: string; title: string }>;
    };

    const btcMarket = markets.items.find((entry) =>
      entry.title.includes("BTC trade above $100k"),
    );
    const fedMarket = markets.items.find((entry) =>
      entry.title.includes("Fed cut rates before July 31, 2026"),
    );

    if (!btcMarket || !fedMarket) {
      throw new Error(`Expected BTC and Fed markets, received ${JSON.stringify(markets.items)}`);
    }

    const proposalTitles = proposals.items.map((proposal) => proposal.title).sort();
    if (
      proposalTitles.length < 2 ||
      !proposalTitles.some((title) => title.includes("BTC trade above $100k")) ||
      !proposalTitles.some((title) => title.includes("Fed cut rates before July 31, 2026"))
    ) {
      throw new Error(`Unexpected proposal set: ${JSON.stringify(proposals.items)}`);
    }

    await waitForText("http://127.0.0.1:3000", "Will BTC trade above $100k by June 30, 2026?");
    await waitForText("http://127.0.0.1:3001/proposals", "Will the Fed cut rates before July 31, 2026?");

    for (const agentId of ["resolver-alpha", "resolver-beta"]) {
      const evidenceResponse = await fetch("http://127.0.0.1:4006/v1/resolution-evidence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-id": agentId,
        },
        body: JSON.stringify({
          market_id: btcMarket.id,
          evidence_type: "url",
          summary: "Outcome YES confirmed from official source.",
          source_url: "https://www.cmegroup.com/markets/cryptocurrencies/bitcoin.html",
          observed_at: "2026-06-30T20:00:00Z",
          observation_payload: {
            price: 100500,
          },
        }),
      });

      if (!evidenceResponse.ok) {
        throw new Error(`Resolution evidence submission failed with ${evidenceResponse.status}`);
      }
    }

    const conflictingEvidence = [
      {
        agentId: "resolver-gamma",
        summary: "Outcome YES according to official rate decision source.",
        observation_payload: {
          previous_upper_bound_bps: 450,
          current_upper_bound_bps: 425,
        },
      },
      {
        agentId: "resolver-delta",
        summary: "Outcome NO according to official rate decision source.",
        observation_payload: {
          previous_upper_bound_bps: 450,
          current_upper_bound_bps: 450,
        },
      },
    ];

    for (const entry of conflictingEvidence) {
      const evidenceResponse = await fetch("http://127.0.0.1:4006/v1/resolution-evidence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-id": entry.agentId,
        },
        body: JSON.stringify({
          market_id: fedMarket.id,
          evidence_type: "url",
          summary: entry.summary,
          source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
          observed_at: "2026-07-31T19:00:00Z",
          observation_payload: entry.observation_payload,
        }),
      });

      if (!evidenceResponse.ok) {
        throw new Error(`Conflicting evidence submission failed with ${evidenceResponse.status}`);
      }
    }

    const resolutions = (await waitForJson("http://127.0.0.1:4006/v1/resolutions")) as {
      items: Array<{ market_id: string; status: string; final_outcome: string | null }>;
    };
    const finalizedResolution = resolutions.items.find((entry) => entry.market_id === btcMarket.id);
    const quarantinedResolution = resolutions.items.find((entry) => entry.market_id === fedMarket.id);

    if (
      !finalizedResolution ||
      finalizedResolution.status !== "finalized" ||
      finalizedResolution.final_outcome !== "YES"
    ) {
      throw new Error(`Unexpected resolution state: ${JSON.stringify(resolutions.items)}`);
    }

    if (!quarantinedResolution || quarantinedResolution.status !== "quarantined") {
      throw new Error(`Expected quarantined resolution state: ${JSON.stringify(resolutions.items)}`);
    }

    const marketCreator = processes.find((entry) => entry.name === "market-creator");
    if (!marketCreator) {
      throw new Error("market-creator process not found");
    }
    await stopProcess(marketCreator);

    const proposalPipeline = processes.find((entry) => entry.name === "proposal-pipeline");
    const marketService = processes.find((entry) => entry.name === "market-service");
    const resolutionService = processes.find((entry) => entry.name === "resolution-service");

    if (!proposalPipeline || !marketService || !resolutionService) {
      throw new Error("Missing persisted service process for restart validation");
    }

    await stopProcess(proposalPipeline);
    await stopProcess(marketService);
    await stopProcess(resolutionService);

    restartProcess(processes, marketService);
    restartProcess(processes, proposalPipeline);
    restartProcess(processes, resolutionService);

    await waitForJson("http://127.0.0.1:4003/health");
    await waitForJson("http://127.0.0.1:4004/health");
    await waitForJson("http://127.0.0.1:4005/health");
    await waitForJson("http://127.0.0.1:4006/health");

    const persistedProposals = (await waitForJson("http://127.0.0.1:4005/v1/proposals")) as {
      items: Array<{ status: string; title: string }>;
    };
    if (
      persistedProposals.items.length < 2 ||
      !persistedProposals.items.every((proposal) => proposal.status === "published")
    ) {
      throw new Error(`Proposals were not persisted across restart: ${JSON.stringify(persistedProposals.items)}`);
    }

    const persistedMarkets = (await waitForJson("http://127.0.0.1:4003/v1/markets")) as {
      items: Array<{ id: string; title: string }>;
    };
    if (
      persistedMarkets.items.length < 2 ||
      !persistedMarkets.items.some((market) => market.id === btcMarket.id) ||
      !persistedMarkets.items.some((market) => market.id === fedMarket.id)
    ) {
      throw new Error(`Markets were not persisted across restart: ${JSON.stringify(persistedMarkets.items)}`);
    }

    const persistedResolutions = (await waitForJson("http://127.0.0.1:4006/v1/resolutions")) as {
      items: Array<{ market_id: string; status: string; final_outcome: string | null }>;
    };
    const persistedBtcResolution = persistedResolutions.items.find((entry) => entry.market_id === btcMarket.id);
    const persistedFedResolution = persistedResolutions.items.find((entry) => entry.market_id === fedMarket.id);
    if (
      !persistedBtcResolution ||
      persistedBtcResolution.status !== "finalized" ||
      persistedBtcResolution.final_outcome !== "YES"
    ) {
      throw new Error(`Finalized resolution was not persisted: ${JSON.stringify(persistedResolutions.items)}`);
    }
    if (!persistedFedResolution || persistedFedResolution.status !== "quarantined") {
      throw new Error(`Quarantined resolution was not persisted: ${JSON.stringify(persistedResolutions.items)}`);
    }

    await waitForText("http://127.0.0.1:3000", "Will BTC trade above $100k by June 30, 2026?");
    await waitForText("http://127.0.0.1:3001/proposals", "Will the Fed cut rates before July 31, 2026?");

    console.log("live-test ok");
  } finally {
    await Promise.all(
      processes.map((process) => stopProcess(process)),
    );

    await new Promise<void>((resolve, reject) => {
      feedServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
