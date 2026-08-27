const base = process.env.API_BASE_URL ?? "http://127.0.0.1:8080";
const failures = [];

async function request(path, allowedStatuses = [200]) {
  const response = await fetch(`${base}${path}`);
  const body = await response.json().catch(() => ({}));
  console.log(`GET ${path}: ${response.status}`);
  if (!allowedStatuses.includes(response.status)) failures.push(`${path}: ${response.status}`);
  return { response, body };
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

for (const path of [
  "/",
  "/healthz",
  "/readyz",
  "/openapi.json",
  "/docs",
  "/v1/sources",
  "/v1/meshcore",
  "/v1/meshcore/nodes?limit=1",
  "/v1/meshcore/observers?limit=1",
  "/v1/meshcore/iata",
  "/v1/meshcore/regions",
  "/v1/meshcore/packets?limit=1",
  "/v1/meshcore/messages?limit=1",
  "/v1/meshcore/telemetry?limit=1",
  "/v1/meshcore/traces?limit=1",
  "/v1/meshcore/stats",
  "/v1/meshcore/activity",
]) {
  const { body } = await request(path);
  if (path.includes("?limit=1")) {
    check(Array.isArray(body.data), `${path}: missing collection data`);
    check(body.pagination?.limit === 1, `${path}: missing bounded pagination`);
  }
}

const sources = (await request("/v1/sources")).body;
check(sources.data?.[0]?.id === "meshcore", "/v1/sources: invalid MeshCore discovery");
check(sources.data?.[0]?.url === "/v1/meshcore", "/v1/sources: invalid source URL");

const openapi = (await request("/openapi.json")).body;
check(openapi.info?.title === "Meshat.se REST API", "/openapi.json: invalid title");
check(openapi.paths?.["/v1/meshcore/nodes"], "/openapi.json: nodes route missing");
check(!openapi.components?.securitySchemes, "/openapi.json: unexpected auth schemes");

const docs = await request("/v1/docs", [200, 503]);
if (docs.response.status === 200) {
  check(Array.isArray(docs.body.data?.files), "/v1/docs: missing file index");
  check(Boolean(docs.body.data?.commit), "/v1/docs: missing source commit");
} else {
  check(docs.body.error?.code === "DOCS_UNAVAILABLE", "/v1/docs: wrong degraded error");
}

const unsupported = await request("/v1/meshcore/nodes?unsupported=value", [400]);
check(unsupported.body.error?.code === "INVALID_ARGUMENT", "unsupported query: wrong error");

// Message cursor pagination live smoke: follow the returned next_cursor to a
// second page and verify it succeeds with no duplicate message ids. Skipped
// naturally when the production data has no further page.
const messagesPage1 = await request("/v1/meshcore/messages?limit=2");
const messagesCursor = messagesPage1.body.pagination?.next_cursor;
check(Array.isArray(messagesPage1.body.data), "messages page 1: missing data array");
if (typeof messagesCursor === "string" && messagesCursor.length > 0) {
  const encoded = encodeURIComponent(messagesCursor);
  const messagesPage2 = await request(`/v1/meshcore/messages?limit=2&cursor=${encoded}`);
  check(Array.isArray(messagesPage2.body.data), "messages page 2: missing data array");
  if (Array.isArray(messagesPage2.body.data)) {
    const seen = new Set(messagesPage1.body.data.map((message) => message.id));
    for (const message of messagesPage2.body.data) {
      check(!seen.has(message.id), `messages page 2: duplicate message id ${message.id}`);
      seen.add(message.id);
    }
  }
} else {
  console.log("messages: no next_cursor on page 1, skipping second-page smoke");
}

for (const forbidden of [
  "/api/v1",
  "/v1/tables",
  "/v1/query",
  "/v1/schema",
  "/v1/meshcore/scopes",
]) {
  const response = await fetch(`${base}${forbidden}`);
  const body = await response.json().catch(() => ({}));
  console.log(`GET ${forbidden}: ${response.status}`);
  if (response.status !== 404) failures.push(`${forbidden}: expected 404, got ${response.status}`);
  check(body.error?.code === "NOT_FOUND", `${forbidden}: wrong not-found envelope`);
}

if (failures.length) throw new Error(`Endpoint failures:\n${failures.join("\n")}`);
