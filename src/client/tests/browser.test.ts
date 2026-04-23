import * as pod from "./pod";
import * as k8s from "../";
import { Cluster } from "../../cluster";

pod.tests(k8s, new k8s.KubeConfig(new Cluster()));
