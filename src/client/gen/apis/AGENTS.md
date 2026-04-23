Where I have generally tried to mirror the structure of the
kubernetes-client/javascript repository, this directory is a deviation.

In types/ I am exposing the shape of each API as it appears in
kubernetes-client/javascript. In impls/ I'm exposing the implementation.

The reason I am doing this is that it is not possible to expose just
implementations that exactly match the shape of the implemenetations in
kubernetes-client/javascript. This is for 2 reasons:

1. It would mean I can't add any extra properties to the API classes, and my API classes need to hold references to things like my fake etcd.
2. It would mean my fakes would have to implement hundreds of API methods that I don't want to implement, because I plan to only support a subset of the k8s API surface.

When implementing a new API method, look up the real structure in
kubernetes-client/javascript/src/gen/types/ObjectParamAPI.ts and decompose it
into a set of interfaces to go in the types directory (see types/CoreV1Api.ts
for an example), and then a dummy implementation in impls/ in the relevant file.
