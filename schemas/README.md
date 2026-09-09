# Output contracts

| Contract                            | Schema                                                               | Authority                                                               |
| ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Native inventory/audit report `2.0` | [native/report-v2.schema.json](native/report-v2.schema.json)         | Generated from `src/schema.js`; `npm run schemas:check` prevents drift. |
| Render bundle `1.0`                 | [render/v1/bundle.schema.json](render/v1/bundle.schema.json)         | Producer-neutral export manifest.                                       |
| Render repository `1.0`             | [render/v1/repository.schema.json](render/v1/repository.schema.json) | Embedded repository entry, referenced by the bundle schema.             |
| Render routes `1.0`                 | [render/v1/routes.schema.json](render/v1/routes.schema.json)         | A referenced route-observation file.                                    |

Native saved-state schemas are also generated from `src/saved-state-schema.js`:

- [Organization inventory](native/organization-v1.schema.json)
- [Organization integrity manifest](native/organization-manifest-v1.schema.json)
- [Workspace source provenance](native/workspace-source-v1.schema.json)
- [Report diagnostics and summary](native/report-diagnostics-v1.schema.json) — additive
  fields on render results/manifests and saved-state `validation` objects.

Use the public saved-state loaders for complete cross-file, integrity, OpenAPI,
and compatibility checks; schema validation alone cannot verify referenced evidence.
Native refresh state is owned by Express Recon: prepare it using the public API,
not by emulating its manifest. See the [Git workflow](../docs/git-inventory-workflow.md).
Other producers should continue to use render bundles. OpenAPI/Swagger documents
retain their own standard schemas.

Start with the [integration guide](../docs/render-integration.md). Ship all three
render schemas together; their references resolve locally. Schemas are included
in the npm package. Pin a package version or repository tag for reproducibility.
Do not edit published interchange versions in place: preserve existing readers,
introduce an explicit new version for contract changes, and add migration tests.
