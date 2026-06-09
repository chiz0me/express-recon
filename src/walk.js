"use strict";

const { descriptor, ANONYMOUS } = require("./middleware");
const { MOUNT_KEY } = require("./runtime/instrument");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/**
 * Locate the top-level router on an Express app across v4/v5.
 *
 * Express 5 exposes a lazy `app.router` getter; Express 4 stores it on
 * `app._router` after the first route is registered. Touching `app.router`
 * also forces lazy init on v5, which is what we want before walking.
 */
function getRootRouter(app) {
  if (typeof app !== "function" && (!app || !app.use)) {
    throw new Error("express-recon: expected an Express app or Router");
  }
  if (app.router && app.router.stack) return app.router;
  if (app._router && app._router.stack) return app._router;
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
  if (typeof layer[MOUNT_KEY] === "string") return layer[MOUNT_KEY];
  const re = layer.regexp;
  if (!re) return "";
  if (re.fast_slash) return "";
  if (re.fast_star) return "*";
  const source = re.toString();
  const match = source.match(/^\/\^\\?\/?(.*?)\\\/\?\(\?=\\\/\|\$\)\/i?$/);
  if (!match) return null;
  return "/" + match[1].replace(/\\(.)/g, "$1");
}

function isErrorHandler(handle) {
  return typeof handle === "function" && handle.length === 4;
}

function middlewareName(layer) {
  if (layer.name && layer.name !== "<anonymous>") return layer.name;
  if (layer.handle && layer.handle.name) return layer.handle.name;
  return "<anonymous>";
}

function methodsFor(route) {
  if (!route || !route.methods) return [];
  return HTTP_METHODS.filter((m) => route.methods[m]);
}

function routeMiddlewares(route) {
  if (!route || !route.stack) return [];
  const layers = route.stack;
  const middlewareLayers = layers.slice(0, Math.max(layers.length - 1, 0));
  return middlewareLayers.map((layer) => {
    const name = middlewareName(layer);
    return descriptor({ name, kind: name === ANONYMOUS ? "anonymous" : "identifier" });
  });
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
 * @param {string[]} inherited  Middleware names applied before this router.
 * @returns {{routes: object[], globals: string[]}}
 */
function walkRouter(router, basePath, inherited) {
  const routes = [];
  const globals = inherited.slice();
  for (const layer of router.stack) {
    if (layer.route) {
      const methods = methodsFor(layer.route);
      const localMw = routeMiddlewares(layer.route);
      for (const method of methods) {
        routes.push({
          method: method.toUpperCase(),
          path: joinPath(basePath, layer.route.path),
          middlewares: globals.concat(localMw),
          source: null,
        });
      }
      continue;
    }
    if (layer.handle && layer.handle.stack) {
      const mount = extractMountPath(layer);
      const childBase = mount === null ? basePath : joinPath(basePath, mount);
      const child = walkRouter(layer.handle, childBase, globals);
      routes.push(...child.routes);
      continue;
    }
    if (isErrorHandler(layer.handle)) continue;
    const name = middlewareName(layer);
    if (name !== ANONYMOUS) globals.push(descriptor({ name, kind: "identifier" }));
  }
  return { routes, globals };
}

/**
 * Walk an Express app and return the list of routes plus global middleware.
 *
 * @param {object} app  Express application or Router.
 * @returns {{routes: object[], globalMiddleware: string[]}}
 */
function walk(app) {
  const router = getRootRouter(app);
  const { routes, globals } = walkRouter(router, "", []);
  return { routes, globalMiddleware: globals };
}

module.exports = { walk, extractMountPath, joinPath };
