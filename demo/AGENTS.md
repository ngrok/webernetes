# Demo App Instructions

The `demo/` directory is a standalone Vite/React project inside the Webernetes
repository. It exists to show off the `webernetes` library in a browser app.

Repository-level parity instructions for the library do not apply to demo-only
code unless the task explicitly asks to change the library.

Demo-specific simulator fixtures, sample workloads, and custom in-process images
should live in the demo app, preferably in `src/setup.ts` when they are part of
the default demo cluster. Do not add demo-only images or workloads to the
Webernetes library source.
