import { BaseImage } from "./base";

export class PauseImage extends BaseImage {
	static readonly imageName = "registry.k8s.io/pause";
	static readonly imageVersion = "3.10";

	readonly defaultCommand = ["pause"];
}

export class PauseImage39 extends BaseImage {
	static readonly imageName = "registry.k8s.io/pause";
	static readonly imageVersion = "3.9";

	readonly defaultCommand = ["pause"];
}
