/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { parseIP } from "../../go/net";

// Models vendor/k8s.io/utils/net/parse.go ParseIPSloppy.
export const parseIPSloppy = parseIP;
