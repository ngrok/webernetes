/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ManagedFieldsEntry {
	apiVersion?: string;
	fieldsType?: string;
	// oxlint-disable-next-line typescript/no-explicit-any
	fieldsV1?: any;
	manager?: string;
	operation?: string;
	subresource?: string;
	time?: Date;
}
