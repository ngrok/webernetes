/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Golang, translated and modified for Webernetes.
 */

// Models Go src/sort/sort.go Interface.
export interface Interface {
	len(): number;
	less(i: number, j: number): boolean;
	swap(i: number, j: number): void;
}
