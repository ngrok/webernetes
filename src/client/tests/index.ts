import * as real from "@kubernetes/client-node";
import * as fake from "../";

export type k8s = typeof real | typeof fake;
