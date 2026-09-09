"use strict";

// Only descend through fields defined to contain specification objects. Maps
// preserve arbitrary names (including properties named "$ref" or "example").
const FIELDS = {
  root: {
    paths: "paths",
    webhooks: "map:path",
    components: "components",
    definitions: "map:schema",
    parameters: "map:parameter",
    responses: "map:response",
    securityDefinitions: "map:reference",
  },
  components: {
    schemas: "map:schema",
    responses: "map:response",
    parameters: "map:parameter",
    examples: "map:reference",
    requestBodies: "map:body",
    headers: "map:parameter",
    securitySchemes: "map:reference",
    links: "map:reference",
    callbacks: "map:callback",
    pathItems: "map:path",
  },
  path: {
    parameters: "list:parameter",
    get: "operation",
    put: "operation",
    post: "operation",
    delete: "operation",
    options: "operation",
    head: "operation",
    patch: "operation",
    trace: "operation",
    query: "operation",
  },
  operation: {
    parameters: "list:parameter",
    requestBody: "body",
    responses: "map:response",
    callbacks: "map:callback",
  },
  parameter: { schema: "schema", content: "map:media", examples: "map:reference", items: "schema" },
  body: { content: "map:media" },
  response: {
    headers: "map:parameter",
    content: "map:media",
    links: "map:reference",
    schema: "schema",
  },
  media: {
    schema: "schema",
    examples: "map:reference",
    encoding: "map:encoding",
    itemSchema: "schema",
  },
  encoding: { headers: "map:parameter" },
  schema: {
    properties: "map:schema",
    patternProperties: "map:schema",
    definitions: "map:schema",
    $defs: "map:schema",
    dependencies: "map:schema",
    dependentSchemas: "map:schema",
    additionalProperties: "schema",
    unevaluatedProperties: "schema",
    propertyNames: "schema",
    items: "items",
    additionalItems: "schema",
    unevaluatedItems: "schema",
    contains: "schema",
    prefixItems: "list:schema",
    allOf: "list:schema",
    anyOf: "list:schema",
    oneOf: "list:schema",
    not: "schema",
    if: "schema",
    then: "schema",
    else: "schema",
    contentSchema: "schema",
  },
};

function specificationReferences(document) {
  const stack = [[document, document?.openapi || document?.swagger ? "root" : "schema"]];
  const references = [];
  const anchors = new Map();
  let count = 0;
  while (stack.length) {
    if (++count > 2000000) throw new Error("OpenAPI reference complexity limit exceeded");
    const [value, context] = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (context.startsWith("list:")) {
      if (Array.isArray(value)) for (const child of value) stack.push([child, context.slice(5)]);
      continue;
    }
    if (context === "items") {
      stack.push([value, Array.isArray(value) ? "list:schema" : "schema"]);
      continue;
    }
    if (Array.isArray(value)) continue;
    if (context.startsWith("map:") || context === "paths") {
      for (const [key, child] of Object.entries(value)) {
        if (context !== "paths" || key.startsWith("/"))
          stack.push([child, context === "paths" ? "path" : context.slice(4)]);
      }
      continue;
    }
    if (
      typeof value.$ref === "string" &&
      !["root", "components", "operation", "media", "encoding"].includes(context)
    )
      references.push(value.$ref);
    if (context === "schema" && typeof value.$anchor === "string") {
      if (anchors.has(value.$anchor)) throw new Error("Ambiguous OpenAPI reference anchor");
      anchors.set(value.$anchor, value);
    }
    if (context === "callback") {
      for (const [key, child] of Object.entries(value))
        if (key !== "$ref" && !key.startsWith("x-")) stack.push([child, "path"]);
    }
    for (const [field, childContext] of Object.entries(FIELDS[context] || {})) {
      if (Object.hasOwn(value, field)) stack.push([value[field], childContext]);
    }
  }
  return { references, anchors };
}

module.exports = { specificationReferences };
