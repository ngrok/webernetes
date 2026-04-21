import { Clock } from "./clock";
import { Etcd } from "./etcd";
import { etcdParityTests } from "./etcd.test-helpers";

etcdParityTests("fake etcd", async () => new Etcd(new Clock()));
