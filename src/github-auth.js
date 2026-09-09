"use strict";

const APP_VARIABLES = ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"];

function credentialFreeEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", ...APP_VARIABLES]) delete clean[name];
  return clean;
}

function opaqueToken(value) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    throw new Error(
      "GitHub token must be an opaque string without whitespace or control characters",
    );
  return value;
}

/** Select one GitHub identity and share installation-token renewal across a scan. */
function createGitHubTokenProvider(options = {}) {
  const environment = options.environment || {};
  const selection = options.auth || "auto";
  if (!["auto", "github-app", "token"].includes(selection))
    throw new Error("--auth must be auto, github-app, or token");
  const settings = [
    options.appId ?? environment.GITHUB_APP_ID,
    options.installationId ?? environment.GITHUB_INSTALLATION_ID,
    options.privateKey ?? environment.GITHUB_APP_PRIVATE_KEY,
  ];
  const present = settings.map((value) => value !== undefined && value !== null && value !== "");
  const mode = selection === "auto" ? (present.some(Boolean) ? "github-app" : "token") : selection;
  if (mode === "github-app" && !present.every(Boolean))
    throw new Error(`Incomplete GitHub App credentials: supply ${APP_VARIABLES.join(", ")}`);
  const secrets = new Set();
  const remember = (value) => {
    if (typeof value === "string" && value) {
      secrets.add(value);
      secrets.add(Buffer.from(`x-access-token:${value}`).toString("base64"));
    }
    return value;
  };
  for (const value of [options.token, environment.GH_TOKEN, environment.GITHUB_TOKEN, settings[2]])
    remember(value);
  const redact = (value) => {
    let result = value instanceof Error ? value.message : String(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length))
      result = result.split(secret).join("[REDACTED]");
    return result;
  };
  if (mode === "token") {
    const token = opaqueToken(options.token ?? (environment.GH_TOKEN || environment.GITHUB_TOKEN));
    return {
      mode,
      getToken: async () => token,
      verifyOrganization: async () => ({
        mode,
        repositorySelection: "unknown",
        authenticated: Boolean(token),
      }),
      redact,
    };
  }
  const [appId, installationId] = settings.map((value, index) =>
    index < 2 ? String(value) : value,
  );
  if (
    ![appId, installationId].every(
      (value) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)),
    )
  )
    throw new Error("GitHub App and installation IDs must be positive safe integers");
  if (typeof settings[2] !== "string")
    throw new Error("GitHub App private key must be a PEM string");
  const privateKey = remember(settings[2].replace(/\\n/g, "\n"));
  const now = options.now || Date.now;
  let sdk, cached, pending, verified;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  async function jsonRequest(urlPath, authorization, method = "GET") {
    remember(authorization.replace(/^bearer /i, ""));
    const response = await fetchImpl(`https://api.github.com${urlPath}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(options.apiTimeoutMs || 30000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: authorization,
      },
    });
    if (!response.ok)
      throw new Error(`GitHub App authentication failed with HTTP ${response.status}`);
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error("GitHub App response exceeds 1 MiB");
          chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString("utf8");
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } else text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("GitHub App response exceeds 1 MiB");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("GitHub App returned invalid JSON");
    }
    if (data.token) remember(data.token);
    return data;
  }
  async function auth() {
    sdk ||= import("@octokit/auth-app").then(({ createAppAuth }) =>
      createAppAuth({
        appId,
        installationId,
        privateKey,
        log: { warn() {} },
        request: async (_route, parameters) => ({
          data: await jsonRequest(
            `/app/installations/${installationId}/access_tokens`,
            parameters.headers.authorization,
            "POST",
          ),
        }),
      }),
    );
    return sdk;
  }
  async function getToken() {
    if (cached && cached.expires > now() + 5 * 60 * 1000) return cached.token;
    if (!pending)
      pending = (async () => {
        try {
          const result = await (
            await auth()
          )({ type: "installation", installationId, refresh: true });
          const token = remember(opaqueToken(result.token));
          const expires = Date.parse(result.expiresAt);
          if (!token || !Number.isFinite(expires) || expires <= now() + 5 * 60 * 1000)
            throw new Error("GitHub App returned an unusable or nearly expired installation token");
          cached = { token, expires };
          return token;
        } catch (error) {
          throw new Error(`GitHub App token renewal failed: ${redact(error)}`);
        }
      })().finally(() => {
        pending = null;
      });
    return pending;
  }
  async function verifyOrganization(organization) {
    try {
      if (!verified) {
        const jwt = remember((await (await auth())({ type: "app" })).token);
        verified = await jsonRequest(`/app/installations/${installationId}`, `Bearer ${jwt}`);
      }
      if (
        verified.account?.type !== "Organization" ||
        verified.account?.login?.toLowerCase() !== organization.toLowerCase() ||
        String(verified.id) !== installationId
      )
        throw new Error("GitHub App installation does not belong to the requested organization");
      if (!["all", "selected"].includes(verified.repository_selection))
        throw new Error("GitHub App installation did not report repository access scope");
      return {
        mode,
        appId,
        installationId,
        repositorySelection: verified.repository_selection,
        authenticated: true,
      };
    } catch (error) {
      throw new Error(redact(error));
    }
  }
  return { mode, getToken, verifyOrganization, redact };
}

module.exports = { createGitHubTokenProvider, credentialFreeEnvironment, opaqueToken };
