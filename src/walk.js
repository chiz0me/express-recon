"use strict";

const { descriptor, ANONYMOUS } = require("./middleware");
const { MOUNT_KEY, SOURCE_KEY } = require("./runtime/instrument");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/**
 * Locate the top-level router on an Express app across v4/v5.
 *
 * Express 5 exposes a lazy `app.router` getter; Express 4 stores it on
 * `app._router` after the first route is registered. Express 4 also defines a
 * deprecated `app.router` getter that throws when touched, so `_router` must be
 * checked first.
 */
function getRootRouter(app) {
  if (typeof app !== "function" && (!app || !app.use)) {
    throw new Error("express-recon: expected an Express app or Router");
  }
  if (app._router && app._router.stack) return app._router;
  try {
    if (app.router && app.router.stack) return app.router;
  } catch {
    // Express 4's deprecated app.router getter throws; _router was checked above.
  }
  if (app.stack) return app;
  throw new Error("express-recon: app has no router stack — register at least one route first");
}

/**
 * Recover the mount path of a `app.use(path, ...)` layer.
 *
 * Prefers the original string captured by `instrument()` at registration time
 * (the only reliable source on Express 5, which compiles the path away). Falls
 * back to reconstructing from `layer.regexp` for un-instrumented Express 4 apps:
 * two fast-path flags signal match-everything (`fast_slash`) or match-nothing
 * (`fast_star`); otherwise strip the well-known prefix/suffix and unescape.
 */
function extractMountPath(layer) {
  if (typeof layer[MOUNT_KEY] === "string" || Array.isArray(layer[MOUNT_KEY]))
    return layer[MOUNT_KEY];
  const re = layer.regexp;
  if (!re) return "";
  if (re.fast_slash) return "";
  if (re.fast_star) return "*";
  const source = re.toString();
  const match = source.match(/^\/\^\\?\/?(.*?)\\\/\?\(\?=\\\/\|\$\)\/i?$/);
  if (!match) return null;
  return "/" + match[1].replace(/\\(.)/g, "$1");
}

/**
 * Does a middleware scoped to `use(scopeAbs, mw)` guard a route at `full`?
 * Express matches mount prefixes on path-segment boundaries. Unresolvable
 * (`<dynamic>`) segments on either side can't be disproven, so they keep the
 * middleware in the chain.
 */
function scopedTo(full, scopeAbs) {
  if (scopeAbs == null) return true;
  if (full.includes("<dynamic>") || scopeAbs.includes("<dynamic>")) return true;
  return full === scopeAbs || full.startsWith(scopeAbs + "/");
}

/**
 * Absolute guard scopes for a middleware layer's mount path, or null when it
 * applies to the whole subtree ("" = no path arg, "*"/wildcards = not a literal
 * prefix, null = a path exists but couldn't be recovered — conservative).
 */
function middlewareScopes(mount, basePath) {
  const parts = Array.isArray(mount) ? mount : [mount];
  const scopes = [];
  for (const p of parts) {
    if (p == null || p === "" || p === "/" || p.includes("*")) return null;
    scopes.push(joinPath(basePath, p));
  }
  return scopes;
}

function isErrorHandler(handle) {
  return typeof handle === "function" && handle.length === 4;
}

/** Layer display name; `fn.bind()` prepends "bound ", which would break allowlist matching. */
function middlewareName(layer) {
  const name =
    (layer.name && layer.name !== "<anonymous>" && layer.name) ||
    (layer.handle && layer.handle.name) ||
    "";
  const stripped = name.replace(/^(bound )+/, "");
  return stripped || "<anonymous>";
}

/**
 * Verbs a route answers. A pure `route.all()` sets only `methods._all` and is
 * emitted as "all"; when named verbs coexist (`.all(guard).get(h)`) the `.all`
 * layers act as middleware for those verbs, not as an endpoint of their own.
 */
function methodsFor(route) {
  if (!route || !route.methods) return [];
  const methods = HTTP_METHODS.filter((m) => route.methods[m]);
  if (route.methods._all && methods.length === 0) methods.push("all");
  return methods;
}

/**
 * Route-stack layers relevant to `method`. Layers carry the verb they were
 * registered for (`.get(auth, h)` → auth/h have `method: "get"`; `.all()`
 * layers have `method: undefined` and run for every verb).
 */
function verbLayers(route, method) {
  if (!route || !route.stack) return [];
  return route.stack.filter((l) => l.method === undefined || l.method === method);
}

/**
 * Middleware ahead of `method`'s handler, filtered per verb — otherwise one
 * verb's guard leaks into its siblings.
 */
function routeMiddlewares(route, method) {
  const layers = verbLayers(route, method);
  const middlewareLayers = layers.slice(0, Math.max(layers.length - 1, 0));
  return middlewareLayers.map((layer) => {
    const name = middlewareName(layer);
    return descriptor({ name, kind: name === ANONYMOUS ? "anonymous" : "identifier" });
  });
}

/** Registration call site stamped by `instrument()`, latest layer first. */
function routeSource(route, method) {
  const layers = verbLayers(route, method);
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i][SOURCE_KEY]) return layers[i][SOURCE_KEY];
  }
  return null;
}

function joinPath(base, segment) {
  if (!segment || segment === "/") return base || "/";
  const left = (base || "").replace(/\/$/, "");
  const right = segment.startsWith("/") ? segment : "/" + segment;
  const joined = left + right;
  return joined === "" ? "/" : joined;
}

/**
 * Recursively walk a router stack, collecting routes + the global middleware
 * chain applied above each mounted router.
 *
 * @param {object} router  An Express Router (has `.stack`).
 * @param {string} basePath  Accumulated mount path from parent layers.
 * @param {object[]} inherited  Middleware descriptors applied before this router.
 * @param {boolean} partial  An ancestor mount path could not be recovered.
 * @returns {{routes: object[], globals: object[]}}
 */
function walkRouter(router, basePath, inherited, partial) {
  const routes = [];
  const globals = inherited.slice();
  for (const layer of router.stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of methodsFor(layer.route)) {
        const localMw = routeMiddlewares(layer.route, method);
        for (const path of paths) {
          // Express also accepts RegExp route paths. They cannot be represented
          // as a concrete inventory/OpenAPI path, but they must not crash the
          // runtime walker. Keep the route visible as a partial dynamic path;
          // instrumentation/source evidence still points reviewers to the
          // original registration.
          const dynamicPath = typeof path !== "string";
          const full = joinPath(basePath, dynamicPath ? "<dynamic>" : path);
          const chain = globals
            .filter((g) => g.scopes === null || g.scopes.some((s) => scopedTo(full, s)))
            .map((g) => g.mw);
          routes.push({
            method: method.toUpperCase(),
            path: full,
            middlewares: chain.concat(localMw),
            source: routeSource(layer.route, method),
            pathConfidence: partial || dynamicPath ? "partial" : "full",
          });
        }
      }
      continue;
    }
    if (layer.handle && layer.handle.stack) {
      const mount = extractMountPath(layer);
      // `null` means the mount path exists but couldn't be recovered (regexp
      // reverse-parse failed): mark the subtree rather than silently dropping
      // the prefix. "" means mounted at the root — nothing to append.
      const mounts = Array.isArray(mount) ? mount : [mount];
      for (const m of mounts) {
        const childBase = m === null ? joinPath(basePath, "<dynamic>") : joinPath(basePath, m);
        const child = walkRouter(layer.handle, childBase, globals, partial || m === null);
        routes.push(...child.routes);
      }
      continue;
    }
    if (isErrorHandler(layer.handle)) continue;
    const name = middlewareName(layer);
    globals.push({
      mw: descriptor({ name, kind: name === ANONYMOUS ? "anonymous" : "identifier" }),
      scopes: middlewareScopes(extractMountPath(layer), basePath),
    });
  }
  return { routes, globals };
}

/**
 * Walk an Express app and return the list of routes plus global middleware.
 *
 * @param {object} app  Express application or Router.
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function walk(app) {
  const router = getRootRouter(app);
  const { routes, globals } = walkRouter(router, "", [], false);
  const applicationId = "runtime:default";
  for (const route of routes) route.applicationId = applicationId;
  const globalMiddleware = globals.map((g) => g.mw);
  return {
    routes,
    globalMiddleware,
    applications: [
      {
        id: applicationId,
        name: "runtime application",
        source: null,
        routeCount: routes.length,
        globalMiddleware,
      },
    ],
  };
}

module.exports = { walk, extractMountPath, joinPath, scopedTo };
