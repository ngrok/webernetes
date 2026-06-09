/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models vendor/k8s.io/utils/clock/clock.go PassiveClock.
export interface PassiveClock {
	now(): Date;
	since(ts: Date): number;
}
