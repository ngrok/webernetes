import { Server } from "./server";

export class Kubelet {
	server: Server;

	public constructor(server: Server) {
		this.server = server;
	}
}
