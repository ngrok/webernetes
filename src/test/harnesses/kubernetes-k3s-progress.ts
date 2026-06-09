import { MultiBar, Presets, type SingleBar } from "cli-progress";

import type { ImagePullStatus, K3sSetupProgress } from "./kubernetes-k3s-setup";

export class ConsoleK3sSetupProgress implements K3sSetupProgress {
	private readonly bars = new Map<string, SingleBar>();
	private readonly downloadedBytes = new Map<string, number>();
	private readonly totalBytes = new Map<string, number>();
	private readonly imageLabelWidth = 20;
	private readonly bytesWidth = 14;
	private readonly multibar = process.stderr.isTTY
		? new MultiBar(
				{
					format: "[k3s] {image} [{bar}] {percent} {bytes}",
					barsize: progressBarSize(this.imageLabelWidth, this.bytesWidth),
					clearOnComplete: false,
					hideCursor: true,
					stream: process.stderr,
					stopOnComplete: false,
				},
				Presets.shades_classic,
			)
		: undefined;
	private lastNonTtyProgressAt = 0;

	info(message: string): void {
		this.writeLine(message);
	}

	waitingForLock(path: string): void {
		this.writeLine(`waiting for startup lock: ${path}`);
	}

	removedStaleLock(path: string): void {
		this.writeLine(`removed stale startup lock: ${path}`);
	}

	imageStart(index: number, total: number, image: string): void {
		if (!this.multibar) {
			this.writeLine(`pulling image ${index}/${total}: ${image}`);
			return;
		}
		this.bars.set(
			image,
			this.multibar.create(1, 0, {
				image: imageLabel(image, this.imageLabelWidth),
				bytes: padSlot("0/?", this.bytesWidth),
				percent: "  0%",
			}),
		);
	}

	imageProgress(index: number, total: number, image: string, status: ImagePullStatus): void {
		if (this.multibar) {
			this.updateImageBar(image, status);
			return;
		}
		if (Date.now() - this.lastNonTtyProgressAt < 1_500) {
			return;
		}
		this.lastNonTtyProgressAt = Date.now();
		this.writeLine(`pulling image ${index}/${total}: ${image} ${formatStatus(status)}`);
	}

	imageDone(index: number, total: number, image: string): void {
		if (this.multibar) {
			const bar = this.bars.get(image);
			if (bar) {
				const totalSize = this.totalBytes.get(image);
				const finalValue =
					totalSize ?? Math.max(this.downloadedBytes.get(image) ?? 0, bar.getTotal());
				this.downloadedBytes.set(image, finalValue);
				if (totalSize && totalSize !== bar.getTotal()) {
					bar.setTotal(totalSize);
				}
				bar.update(finalValue, {
					bytes: padSlot(formatByteRatio(finalValue, totalSize), this.bytesWidth),
					percent: formatPercent(finalValue, bar.getTotal()),
				});
			}
			return;
		}
		this.writeLine(`pulled image ${index}/${total}: ${image}`);
	}

	imageFallback(index: number, total: number, image: string): void {
		if (this.multibar) {
			this.updateImageBar(image, { message: "streaming unavailable; using crictl" });
			return;
		}
		this.writeLine(`pulling image ${index}/${total}: ${image} streaming unavailable; using crictl`);
	}

	complete(): void {
		this.writeLine("k3s setup complete");
	}

	finish(): void {
		this.multibar?.stop();
	}

	private writeLine(message: string): void {
		process.stderr.write(`[k3s] ${message}\n`);
	}

	private updateImageBar(image: string, status: ImagePullStatus): void {
		const bar = this.bars.get(image);
		if (!bar) {
			return;
		}
		const previous = this.downloadedBytes.get(image) ?? 0;
		const observed = status.downloadedBytes ?? previous;
		const current = Math.max(previous, observed);
		this.downloadedBytes.set(image, current);

		const knownTotal = status.totalBytes ?? this.totalBytes.get(image);
		if (knownTotal) {
			this.totalBytes.set(image, knownTotal);
		}
		const total = Math.max(knownTotal ?? bar.getTotal(), current, 1);
		if (total !== bar.getTotal()) {
			bar.setTotal(total);
		}
		bar.update(current, {
			bytes: padSlot(formatByteRatio(current, knownTotal), this.bytesWidth),
			percent: formatPercent(current, total),
		});
	}
}

function progressBarSize(imageLabelWidth: number, bytesWidth: number): number {
	const columns = process.stderr.columns ?? 120;
	const reservedColumns =
		"[k3s] ".length + imageLabelWidth + " [] ".length + "100% ".length + bytesWidth;
	return Math.max(12, columns - reservedColumns);
}

function imageLabel(image: string, maxLength: number): string {
	const meaningfulName = image.split("/").at(-1) ?? image;
	if (meaningfulName.length <= maxLength) {
		return meaningfulName.padEnd(maxLength, " ");
	}
	return `...${meaningfulName.slice(-(maxLength - 3))}`;
}

function formatStatus(status: ImagePullStatus): string {
	if (status.message) {
		return status.message;
	}
	const parts = [formatBytes(status.downloadedBytes ?? 0)];
	if (status.totalBytes) {
		parts.push(`/ ${formatBytes(status.totalBytes)}`);
	}
	if (status.rateBytesPerSecond) {
		parts.push(`(${formatBytes(status.rateBytesPerSecond)}/s)`);
	}
	return parts.join(" ");
}

function formatByteRatio(current: number, total: number | undefined): string {
	if (!total) {
		return formatBytes(current);
	}
	const unit = byteDisplayUnit(total);
	const totalValue = formatByteValue(total, unit, total);
	return `${formatByteValue(current, unit, total).padStart(totalValue.length)}/${totalValue} ${unit}`;
}

function formatBytes(value: number): string {
	const unit = byteDisplayUnit(value);
	return `${formatByteValue(value, unit, value)} ${unit}`;
}

function formatByteValue(value: number, unit: string, scaleReference: number): string {
	if (unit === "B") {
		return String(Math.round(value));
	}
	const scaled = value / byteDisplayUnitMultiplier(unit);
	const scaledReference = scaleReference / byteDisplayUnitMultiplier(unit);
	return scaled.toFixed(scaledReference < 10 ? 1 : 0);
}

function byteDisplayUnit(value: number): string {
	if (value < 1024) {
		return "B";
	}
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let scaled = value / 1024;
	for (const unit of units) {
		if (scaled < 1024) {
			return unit;
		}
		scaled /= 1024;
	}
	return "PiB";
}

function byteDisplayUnitMultiplier(unit: string): number {
	switch (unit) {
		case "KiB":
			return 1024;
		case "MiB":
			return 1024 ** 2;
		case "GiB":
			return 1024 ** 3;
		case "TiB":
			return 1024 ** 4;
		case "PiB":
			return 1024 ** 5;
		default:
			return 1;
	}
}

function formatPercent(current: number, total: number): string {
	const percentage = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
	return `${String(percentage).padStart(3)}%`;
}

function padSlot(value: string, width: number): string {
	if (value.length >= width) {
		return value;
	}
	return value.padStart(width);
}
