import type { ProcessContext } from "./runtime";

export interface ImageDefinition {
	defaultCommand?: readonly string[];
	exec(context: ProcessContext, argv: readonly string[]): Promise<number>;
}

export interface ImageConstructor {
	new (): ImageDefinition;
	readonly imageName: string;
	readonly imageVersion: string;
}

export class ImageRegistry {
	private readonly images = new Map<string, () => ImageDefinition>();
	private readonly versions = new Map<string, Set<string>>();

	register(image: ImageConstructor): void {
		const imageRef = imageReference(image.imageName, image.imageVersion);
		this.images.set(imageRef, () => new image());
		let versions = this.versions.get(image.imageName);
		if (!versions) {
			versions = new Set();
			this.versions.set(image.imageName, versions);
		}
		versions.add(image.imageVersion);
	}

	create(imageRef: string): ImageDefinition | undefined {
		return this.images.get(this.resolve(imageRef) ?? imageRef)?.();
	}

	has(imageRef: string): boolean {
		const resolved = this.resolve(imageRef);
		return resolved !== undefined && this.images.has(resolved);
	}

	list(): string[] {
		return [...this.images.keys()];
	}

	remove(imageRef: string): void {
		const resolved = this.resolve(imageRef) ?? imageRef;
		this.images.delete(resolved);
		const parsed = parseImageReference(resolved);
		const versions = this.versions.get(parsed.name);
		versions?.delete(parsed.version);
		if (versions?.size === 0) {
			this.versions.delete(parsed.name);
		}
	}

	private resolve(imageRef: string): string | undefined {
		const parsed = parseImageReference(imageRef);
		if (parsed.version !== "latest") {
			return this.images.has(imageRef) ? imageRef : undefined;
		}
		const versions = this.versions.get(parsed.name);
		const version = versions ? latestVersion([...versions]) : undefined;
		return version ? imageReference(parsed.name, version) : undefined;
	}
}

function imageReference(name: string, version: string): string {
	return `${name}:${version}`;
}

function parseImageReference(imageRef: string): { name: string; version: string } {
	const slashIndex = imageRef.lastIndexOf("/");
	const colonIndex = imageRef.lastIndexOf(":");
	if (colonIndex > slashIndex) {
		return {
			name: imageRef.slice(0, colonIndex),
			version: imageRef.slice(colonIndex + 1),
		};
	}
	return { name: imageRef, version: "latest" };
}

function latestVersion(versions: string[]): string | undefined {
	if (versions.length === 0) {
		return undefined;
	}
	return versions.sort(compareVersions).at(-1);
}

function compareVersions(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	if (left === "latest") {
		return 1;
	}
	if (right === "latest") {
		return -1;
	}
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
