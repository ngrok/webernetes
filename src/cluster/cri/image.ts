import type { ProcessContext } from "./runtime";

export interface ImageDefinition {
	defaultCommand?: string[];
	start(context: ProcessContext, argv: readonly string[]): Promise<number>;
	exec(context: ProcessContext, argv: readonly string[]): Promise<number>;
}

export class ImageRegistry {
	private readonly images = new Map<string, ImageDefinition>();

	register(imageRef: string, image: ImageDefinition): void {
		this.images.set(imageRef, image);
	}

	resolve(imageRef: string): ImageDefinition | undefined {
		return this.images.get(imageRef);
	}
}
