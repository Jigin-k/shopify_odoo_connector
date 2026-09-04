export interface OdooConnectionConfig {
  url: string;
  database: string;
  apiKey: string;
}

export class OdooClient {
  private url: string;
  private database: string;
  private apiKey: string;

  constructor(config: OdooConnectionConfig) {
    this.url = config.url.replace(/\/$/, "");
    this.database = config.database;
    this.apiKey = config.apiKey;
  }

  async call<T>(
    model: string,
    method: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch(
      `${this.url}/json/2/${model}/${method}`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Odoo-Database": this.database,
        },

        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Odoo API error ${response.status}: ${errorText}`,
      );
    }

    return (await response.json()) as T;
  }

  async create(model: string, values: Record<string, unknown>): Promise<number> {
    const result = await this.call<number | number[]>(model, "create", {
      vals_list: [values],
    });
    const id = Array.isArray(result) ? result[0] : result;

    if (!id) {
      throw new Error(`Odoo did not return an ID when creating ${model}.`);
    }

    return id;
  }
}
