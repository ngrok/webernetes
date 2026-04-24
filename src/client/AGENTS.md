This directory implements a type-compatible fake version of
https://github.com/kubernetes-client/javascript. Fake in that it is not calling
a real Kubernetes apiserver over HTTP. When looking up details in that
repository, note that it is included in this repo as a dev dependency and should
be locatable in `node_modules/@kubernetes/client-node/`. In this repo that path
may be a pnpm symlink; use `find -L` or inspect the files beneath it directly if
you need to follow the link. For generated API signatures, the authoritative
local references are under `dist/gen/`.

When creating new models, read gen/models/AGENTS.md.

When creating new APIs, read gen/apis/AGENTS.md.
