import type { ProcessContext } from "./runtime";

export interface ImageDefinition {
	defaultCommand?: string[];
	start(context: ProcessContext, argv: readonly string[]): Promise<number>;
	exec(context: ProcessContext, argv: readonly string[]): Promise<number>;
}

export type ImageFactory = () => ImageDefinition;

export class ImageRegistry {
	private readonly images = new Map<string, ImageFactory>();

	register(imageRef: string, image: ImageFactory): void {
		this.images.set(imageRef, image);
	}

	create(imageRef: string): ImageDefinition | undefined {
		return this.images.get(imageRef)?.();
	}

	has(imageRef: string): boolean {
		return this.images.has(imageRef);
	}

	list(): string[] {
		return [...this.images.keys()];
	}

	remove(imageRef: string): void {
		this.images.delete(imageRef);
	}
}
