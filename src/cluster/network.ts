export interface NetworkReceiver {}

export class Network {
	private receivers: Map<string, NetworkReceiver> = new Map();

	register(ip: string, receiver: NetworkReceiver) {
		if (this.receivers.has(ip)) {
			throw new Error(`Receiver for IP ${ip} is already registered`);
		}
		this.receivers.set(ip, receiver);
	}
}
