import { Etcd3 } from "etcd3";
import { GenericContainer, Wait } from "testcontainers";

import { etcdParityTests } from "./etcd.test-helpers";

async function createRealEtcd() {
  const container = await new GenericContainer("registry.k8s.io/etcd:3.6.4-0")
    .withCommand([
      "etcd",
      "--listen-client-urls=http://0.0.0.0:2379",
      "--advertise-client-urls=http://0.0.0.0:2379",
      "--listen-peer-urls=http://0.0.0.0:2380",
      "--initial-advertise-peer-urls=http://0.0.0.0:2380",
      "--initial-cluster=default=http://0.0.0.0:2380",
    ])
    .withExposedPorts(2379)
    .withWaitStrategy(Wait.forLogMessage("ready to serve client requests"))
    .start();

  const client = new Etcd3({
    hosts: [`${container.getHost()}:${container.getMappedPort(2379)}`],
  });

  const originalClose = client.close.bind(client);
  client.close = () => {
    originalClose();
    void container.stop();
  };

  return client;
}

etcdParityTests("real etcd", createRealEtcd);
