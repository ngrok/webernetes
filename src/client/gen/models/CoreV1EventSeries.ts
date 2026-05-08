import type { V1MicroTime } from "../../types";

export interface CoreV1EventSeries {
	count?: number;
	lastObservedTime?: V1MicroTime;
}
