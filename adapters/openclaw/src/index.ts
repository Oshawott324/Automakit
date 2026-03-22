export interface OpenClawAdapterOptions {
  apiBaseUrl: string;
  accessToken: string;
}

export class OpenClawAdapter {
  constructor(private readonly options: OpenClawAdapterOptions) {}

  async listMarkets() {
    const response = await fetch(`${this.options.apiBaseUrl}/v1/markets`, {
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`market request failed with ${response.status}`);
    }

    return response.json();
  }

  async getPortfolio() {
    const response = await fetch(`${this.options.apiBaseUrl}/v1/portfolio`, {
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`portfolio request failed with ${response.status}`);
    }

    return response.json();
  }
}

if (process.env.OPENCLAW_ADAPTER_DEMO === "1") {
  const adapter = new OpenClawAdapter({
    apiBaseUrl: process.env.OPENCLAW_API_BASE_URL ?? "http://localhost:4001",
    accessToken: process.env.OPENCLAW_ACCESS_TOKEN ?? "seed-token",
  });

  adapter
    .getPortfolio()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
