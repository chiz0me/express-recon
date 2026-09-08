# Output contracts

| Contract                            | Schema                                                               | Authority                                                               |
| ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Native inventory/audit report `2.0` | [native/report-v2.schema.json](native/report-v2.schema.json)         | Generated from `src/schema.js`; `npm run schemas:check` prevents drift. |
| Render bundle `1.0`                 | [render/v1/bundle.schema.json](render/v1/bundle.schema.json)         | Producer-neutral export manifest.                                       |
| Render repository `1.0`             | [render/v1/repository.schema.json](render/v1/repository.schema.json) | Embedded repository entry, referenced by the bundle schema.             |
| Render routes `1.0`                 | [render/v1/routes.schema.json](render/v1/routes.schema.json)         | A referenced route-observation file.                                    |

The native snapshot is the existing route-report contract, not a schema for
every native artifact. Repository/organization envelopes, checkpoints, deltas,
and refresh state remain internal native formats; do not emulate them in other
tools. OpenAPI/Swagger documents retain their own standard schemas.

Start with the [integration guide](../docs/render-integration.md). Ship all three
render schemas together; their references resolve locally. Schemas are included
in the npm package. Pin a package version or repository tag for reproducibility.
Do not edit published interchange versions in place: preserve existing readers,
introduce an explicit new version for contract changes, and add migration tests.
