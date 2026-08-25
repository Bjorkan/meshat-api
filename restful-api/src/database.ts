import { SQL } from "bun";

export type DatabaseConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  max: number;
  statement_timeout?: number;
  application_name?: string;
};

/**
 * Creates the explicit Bun.SQL instance used by the REST API.
 *
 * The instance is intentionally constructed here (never the ambient default)
 * so ownership is clear: whoever calls createDatabase also closes it.
 *
 * statement_timeout and application_name travel as connection startup
 * parameters, mirroring what the production meshcore_http role sets at the
 * role level; DATABASE_POOL_MAX maps to the pool `max`.
 */
export function createDatabase(config: DatabaseConfig): SQL {
  return new SQL({
    adapter: "postgres",
    hostname: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    max: config.max,
    tls: config.ssl,
    connection: {
      application_name: String(config.application_name ?? "meshat-rest-api"),
      statement_timeout: `${config.statement_timeout ?? 5_000}ms`,
    },
  });
}
