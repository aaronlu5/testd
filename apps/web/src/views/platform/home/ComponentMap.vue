<template>
  <figure class="map" data-testid="home-component-map">
    <div
      class="map-scroll"
      tabindex="0"
      role="region"
      aria-label="Component relationship diagram (scrollable)"
    >
      <svg
        viewBox="-20 0 980 500"
        role="img"
        aria-labelledby="map-title map-desc"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title id="map-title">How the platform's components relate</title>
        <desc id="map-desc">
          Tests and Test Data are authored. Tests are grouped into Suites. A Run combines a Test, a
          Test Data set and an Environment; a Suite Run combines a Suite and an Environment and
          creates child Runs. The Environment names the targets a Run may call and references the
          secrets it may use. A Run records Step Runs, logs and artifacts.
        </desc>
        <defs>
          <marker
            id="map-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" class="arrow-head" />
          </marker>
        </defs>

        <!-- relationships (drawn first so boxes sit on top) -->
        <g class="edge" marker-end="url(#map-arrow)">
          <path d="M210 202 C255 202 255 62 300 62" />
          <path d="M385 94 V170" />
          <path d="M385 234 V310" />
          <path d="M125 234 V342 H300" />
          <path d="M40 62 H15 V366 H300" class="dashed" />
          <path d="M385 374 V420" />
          <path d="M470 342 H740" />
          <path d="M825 94 V170" />
          <path d="M740 215 C640 215 560 330 470 330" class="dashed" />
          <path d="M740 62 H610 V202 H470" class="dashed" />
        </g>

        <g class="label">
          <text x="246" y="146" text-anchor="end">grouped into</text>
          <text x="393" y="136">launched as</text>
          <text x="393" y="276">creates child</text>
          <text x="133" y="318">run directly</text>
          <text x="2" y="230" transform="rotate(-90 2 230)" text-anchor="middle">
            supplies values
          </text>
          <text x="393" y="402">records</text>
          <text x="605" y="334" text-anchor="middle">calls (allowlisted)</text>
          <text x="833" y="136">references</text>
          <text x="585" y="268" text-anchor="end">credentials, in memory</text>
          <text x="618" y="52" text-anchor="middle">selected for</text>
        </g>

        <!-- authored assets -->
        <g class="node authored">
          <rect x="40" y="30" width="170" height="64" rx="8" />
          <text x="125" y="58" class="title">Test Data</text>
          <text x="125" y="78" class="sub">input values per scenario</text>
        </g>
        <g class="node authored">
          <rect x="40" y="170" width="170" height="64" rx="8" />
          <text x="125" y="198" class="title">Test</text>
          <text x="125" y="218" class="sub">ordered Steps + Breakpoints</text>
        </g>
        <g class="node authored">
          <rect x="300" y="30" width="170" height="64" rx="8" />
          <text x="385" y="58" class="title">Suite</text>
          <text x="385" y="78" class="sub">Tests paired with Test Data</text>
        </g>

        <!-- execution -->
        <g class="node running">
          <rect x="300" y="170" width="170" height="64" rx="8" />
          <text x="385" y="198" class="title">Suite Run</text>
          <text x="385" y="218" class="sub">Suite + Environment</text>
        </g>
        <g class="node running">
          <rect x="300" y="310" width="170" height="64" rx="8" />
          <text x="385" y="338" class="title">Run</text>
          <text x="385" y="358" class="sub">Test + Data + Environment</text>
        </g>
        <g class="node running">
          <rect x="300" y="420" width="170" height="64" rx="8" />
          <text x="385" y="448" class="title">Results</text>
          <text x="385" y="468" class="sub">Step Runs · logs · artifacts</text>
        </g>

        <!-- configuration and external systems -->
        <g class="node external">
          <rect x="740" y="30" width="190" height="64" rx="8" />
          <text x="835" y="58" class="title">Environment</text>
          <text x="835" y="78" class="sub">targets · limits · secret refs</text>
        </g>
        <g class="node external">
          <rect x="740" y="170" width="190" height="64" rx="8" />
          <text x="835" y="198" class="title">Secret stores</text>
          <text x="835" y="218" class="sub">Key Vault · local plain text</text>
        </g>
        <g class="node external">
          <rect x="740" y="310" width="190" height="64" rx="8" />
          <text x="835" y="338" class="title">Targets</text>
          <text x="835" y="358" class="sub">HTTP/APIM · Blob · Service Bus</text>
        </g>
      </svg>
    </div>

    <figcaption class="legend">
      <span class="swatch authored"></span> What you author
      <span class="swatch running"></span> What the worker executes and records
      <span class="swatch external"></span> Configuration and systems under test
      <span class="nowrap">· dashed = used by, solid = leads to</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.map {
  margin: 0;
}
/* Keep the diagram legible on narrow screens: scroll instead of shrinking further. */
.map-scroll {
  overflow-x: auto;
  padding: var(--td-space-3);
  background: var(--td-surface);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-lg);
}
svg {
  min-width: 640px;
  display: block;
  width: 100%;
  height: auto;
}
.edge path {
  fill: none;
  stroke: var(--td-text-faint);
  stroke-width: 1.5;
}
.edge .dashed {
  stroke-dasharray: 4 4;
}
.arrow-head {
  fill: var(--td-text-faint);
}
.label text {
  font-size: 11px;
  fill: var(--td-text-muted);
}
.node rect {
  fill: var(--td-surface-2);
  stroke-width: 1.5;
}
.node text {
  text-anchor: middle;
  fill: var(--td-text);
}
.node .title {
  font-size: 15px;
  font-weight: 650;
}
.node .sub {
  font-size: 11px;
  fill: var(--td-text-muted);
}
.authored rect {
  stroke: var(--td-accent);
}
.running rect {
  stroke: var(--td-running);
}
.external rect {
  stroke: var(--td-text-faint);
}
.legend {
  margin-top: var(--td-space-3);
  font-size: var(--td-text-xs);
  color: var(--td-text-muted);
  text-align: center;
}
.nowrap {
  white-space: nowrap;
}
.swatch {
  display: inline-block;
  width: 0.8rem;
  height: 0.8rem;
  margin: 0 0.3rem 0 0.9rem;
  border: 2px solid;
  border-radius: 3px;
  vertical-align: -0.1rem;
}
.swatch.authored {
  border-color: var(--td-accent);
}
.swatch.running {
  border-color: var(--td-running);
}
.swatch.external {
  border-color: var(--td-text-faint);
}
</style>
