# Webernetes

> Kubernetes that runs in your browser.

To see it in action, [check out the demo!](https://webernetes-demo.ngrok.app/)

_Wait, what?_

This project is a port of a subset of the Kubernetes project to make it such
that clusters can be booted up in the browser, without any backend server
components.

_But why?_

At [ngrok](https://ngrok.com/), we want to make visual and interactive content
about Kubernetes. We didn't want to create and maintain infrastructure for
spinning up real clusters, so we decided to create a browser-based simulator
instead. The hope and dream is that this will make it possible for us (and you!)
to create interactive Kubernetes content that lives for a long time, because the
maintenance burden is much smaller.

**Please note:** This is very experimental. The API is subject to change, the
level of support for different resources is subject to change. I'm kinda
figuring this out as I go.

## How does it work?

First, install webernetes as a dependency:

```bash
npm install webernetes
```

Then define an image to run in your cluster. **Webernetes does not run real
images from Docker Hub, nor is it a goal to do so.**

```typescript
import { BaseImage, type ProcessContext } from "webernetes";

class MyImage extends BaseImage {
	// The imageName and imageVersion variables are what make up the image label
	// you'll use in your container definition. Here we have my-image:1.0 but
	// webernetes also knows what to do if you specify just my-image or
	// my-image:latest
	static readonly imageName = "my-image";
	static readonly imageVersion = "1.0";

	// If no other command is specified in your container manifest, this is the
	// command that will be passed in as argv below.
	readonly defaultCommand = ["server"];

	// exec is the main entrypoint for your image. It will be called with the
	// command-line arguments passed in from your container definition.
	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "server") {
			// The base image defines a bunch of core utils (cat, false, printenv,
			// etc.) so if we don't recognize the command, fall back to the base
			// image.
			return await super.exec(ctx, argv);
		}

		// Binds to port 8080 on this container.
		ctx.listenHttp(8080, async (request) => {
			return {
				statusCode: 200,
				body: "hello, world\n",
			};
		});

		// Required for long-running processes to be cancellable when clusters shut
		// down. If we returned an exit code of 0 here, the listener above would be
		// unregistered because this container will have exited.
		return await ctx.waitUntilKilled();
	}
}
```

Then we create a cluster and register our image with it.

```typescript
import { Cluster } from "webernetes";

const cluster = new Cluster();
cluster.registerImage(MyImage);
```

And then we can run the cluster and spawn a pod using our image in it.

```typescript
// By default this spins up a 3-node cluster. This can't currently be changed.
await cluster.init();

await cluster.apply([
	{
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: "my-pod",
			labels: { app: "my-pod" },
		},
		spec: {
			containers: [
				{
					name: "my-container",
					image: "my-image:1.0",
				},
			],
		},
	},
]);
```

To send a request to your pod, you'll need to create a `Service` to talk to it.
In this case, a `NodePort` service gives us the easiest route.

```typescript
await cluster.apply([
	{
		apiVersion: "v1",
		kind: "Service",
		metadata: { name: "my-service" },
		spec: {
			type: "NodePort",
			ports: [
				{
					port: 80,
					targetPort: 8080,
					nodePort: 31000,
					protocol: "TCP",
				},
			],
			selector: {
				app: "my-pod",
			},
		},
	},
]);

const resp = await cluster.fetch("http://node-1:31000");
const text = await resp.text(); // hello, world
```

Pods are also able to talk to each other over HTTP. To see how this works in a
few runnable examples, check out the code under the `examples/` directory. For
the full visual demo, check out the code under the `demo/` directory.

## What's implemented and what isn't

I've scoped this so far to the bits I need to make the first piece of content
I want to make, which is about probing.

I'll also preface this by saying I am by no means an exhaustive expert on every
detail of Kubernetes, so it is likely that I'm missing some things or I haven't
fully implemented the things I believe I have.

### Nodes

- `Cluster` spins up a 3-node cluster (`node-1`, `node-2`, `node-3`) and that
  isn't configurable yet. I would like to suppose arbitrarily adding and
  removing nodes in the future.

### Namespaces

Supported, including special handling for deleting the resources within a
namespace via a namespace controller (separate to the garbage collector
controller that handles deleting everything else).

### Pods

Basics are supported: `Pod`s can have `Container`s and those containers can
listen for HTTP traffic on ports. They get a pod name, an IP address, they can
speak to other pods by their DNS name or IP address. They can accept environment
variables. They get probed.

What's not supported yet:

- Init or ephemeral containers.
- gRPC probing.
- Volume mounts.
- Any sort of affinity rules.
- Resources.
- Probably a lot of other things, but those are the big ones that come to mine.

### Services

Support for `ClusterIP` and `NodePort` services is in, `LoadBalancer` and
`ExternalName` services are not yet supported. `Pod`s can talk to service DNS
names and the requests will be load balanced across the `Pod`s in the service
using round robin.

UDP isn't supported. TCP kinda sorta isn't either if you think about it, I'm not
emulating that far down the network stack. Stuff can talk HTTP and DNS to each
other and that's it. I don't anticipate ever wanting or needing to change this.
As a result, the distinction between IP families also isn't really modeled.

### EndpointSlices

A fun implementation detail of `Service`s I had no idea existed until starting
this project. These are created to track sets of `Pod`s that are part of a
`Service`. They're usually sharded into 100 `Pod`s each but I haven't done that,
purely for simplicity. They exist, they work how they should, but the sharding
isn't there for now.

### Events

Supported for the most part, and I've tried to make sure we fire the same events
as Kubernetes does. I'm not doing any event aggregating, and it's possible not
all fields are present and correct, but events with messages do get fired and
can be inspected.

### ReplicaSets

Supported and usually created by `Deployment`s. ReplicaSet controller is also in
place and largely at parity with the upstream Kubernetes ReplicaSet controller.

### Deployments

Supported, including `RollingUpdate` and `Recreate` strategies. Deployment
controller is in place and largely at parity with the upstream Kubernetes
Deployment controller.

## Development

This repo uses [mise](https://mise.jdx.dev/) to pin the toolchain (Node, pnpm,
`ast-grep`, `ripgrep`) so it's reproducible across machines. Node is read from
`.nvmrc` and pnpm is single-sourced from `package.json#packageManager`.

After [installing mise](https://mise.jdx.dev/installing-mise.html), from a fresh
clone:

```bash
mise install      # install the pinned tools (and write mise.lock)
mise run setup     # install workspace dependencies from the lockfile
```

Available mise tasks:

- `mise run install` — `pnpm install --frozen-lockfile`.
- `mise run setup` — prepare the repo after a fresh clone (runs `install`).
- `mise run relock` — refresh `mise.lock` to match `.nvmrc` and
  `package.json#packageManager`.
- `mise run doctor` — verify the active tools match the committed pins.

To bump a pinned version, edit `.nvmrc`, `package.json#packageManager`, or
`mise.toml` and run `mise run relock`. The package scripts (`pnpm test`,
`pnpm build`, `pnpm vibe-check`, etc.) are unchanged and run as usual once
dependencies are installed.
