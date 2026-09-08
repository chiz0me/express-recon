# Synthetic render bundle

This fixture contains no real organization data or credentials. A fictional
`sample-recon` producer reports one Django route and one failed repository.
It deliberately demonstrates that valid JSON can still describe incomplete
scan coverage.

- [render-bundle.json](render-bundle.json): manifest, producer/repository identity, outcomes, statistics, and file references.
- [routes.json](routes.json): framework-neutral route observation and unconfirmed auth evidence.
- [openapi.json](openapi.json): self-contained OpenAPI 3.0 document.
- [evidence.json](evidence.json): optional producer-specific JSON diagnostics.

From the Express Recon checkout:

```sh
node src/render-bundle.js examples/render-bundle/render-bundle.json
node src/cli.js render --input examples/render-bundle --out /tmp/render-bundle-example-html
```

Open `/tmp/render-bundle-example-html/index.html` directly in Chrome/Brave.
The top table has the scanned repository, framework filtering, and route counts;
the reference section is initially collapsed. Producer statistics and source
downloads are labeled separately. Follow [the integration guide](../../docs/render-integration.md)
to adapt these files; do not copy their synthetic facts into a real report.
