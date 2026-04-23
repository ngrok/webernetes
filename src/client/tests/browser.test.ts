import * as pod from "./pod";
import * as k8s from "../";
import { Cluster } from "../../cluster";
import { beforeAll } from "vitest";

const cluster = new Cluster();

beforeAll(async () => {
	await cluster.init();
});

pod.tests(k8s, new k8s.KubeConfig(cluster));
