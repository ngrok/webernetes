import { Etcd3 } from "etcd3";
import { afterAll, beforeAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import { etcdParityTests } from "./etcd.test-helpers";

let containerPromise: Promise<StartedTestContainer> | undefined;

async function getEtcdContainer() {
  containerPromise ??= new GenericContainer("registry.k8s.io/etcd:3.6.4-0")
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

  return containerPromise;
}

beforeAll(async () => {
  await getEtcdContainer();
});

afterAll(async () => {
  const container = await containerPromise;
  await container?.stop();
});

async function createRealEtcd() {
  const container = await getEtcdContainer();
  return new Etcd3({
    hosts: [`${container.getHost()}:${container.getMappedPort(2379)}`],
  });
}

etcdParityTests("real etcd", createRealEtcd);
