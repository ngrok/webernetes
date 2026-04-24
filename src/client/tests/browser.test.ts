import * as pod from "./pod";
import * as watch from "./watch";
import * as k8s from "../";
import { Cluster } from "../../cluster";
import { afterAll, beforeAll } from "vitest";

const cluster = new Cluster();

beforeAll(async () => {
	await cluster.init();
});

afterAll(() => {
	cluster.close();
});

pod.tests(k8s, cluster.kubeConfig);
watch.tests(k8s, cluster.kubeConfig);
