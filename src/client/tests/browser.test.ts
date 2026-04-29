import * as pod from "./pod";
import * as service from "./service";
import * as endpointslice from "./endpointslice";
import * as exec from "./exec";
import * as nodeport from "./nodeport";
import * as informer from "./informer";
import * as watch from "./watch";
import * as k8s from "../";
import { Cluster } from "../../cluster";
import { afterAll, beforeAll } from "vitest";

const cluster = new Cluster();

beforeAll(async () => {
	await cluster.init();
	cluster.imageRegistry.register("crccheck/hello-world:latest", {
		async start(context) {
			context.listenHttp(8000, async () => ({
				status: 200,
				body: "<xmp>\nHello World\n</xmp>\n",
			}));
			return await context.waitUntilKilled();
		},
		async exec() {
			return 0;
		},
	});
});

afterAll(() => {
	cluster.close();
});

const nodePortOptions = {
	async sendNodePortRequest(nodePort: number, request?: nodeport.NodePortRequest) {
		return await cluster.fetchNodePort(nodePort, request);
	},
};

pod.tests(k8s, cluster.kubeConfig);
service.tests(k8s, cluster.kubeConfig, nodePortOptions);
endpointslice.tests(k8s, cluster.kubeConfig);
exec.tests(k8s, cluster.kubeConfig);
nodeport.tests(k8s, cluster.kubeConfig, nodePortOptions);
informer.tests(k8s, cluster.kubeConfig);
watch.tests(k8s, cluster.kubeConfig);
