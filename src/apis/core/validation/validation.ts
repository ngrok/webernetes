/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { nameIsDNSSubdomain } from "../../../apimachinery/pkg/api/validation/generic";

// Models kubernetes/pkg/apis/core/validation/validation.go ValidatePodName.
export const validatePodName = nameIsDNSSubdomain;
