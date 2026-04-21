This directory implements a type-compatible fake version of
https://github.com/kubernetes-client/javascript. Fake in that it is not calling
a real Kubernetes apiserver over HTTP. When looking up details in that
repository, note that it is included in this repo as a dev dependency and should
be locatable in node_modules/.

When creating new models, read gen/models/AGENTS.md.

When creating new APIs, read gen/apis/AGENTS.md.
