import { beforeEach, describe, expect, it } from "vitest";

import { Clock } from "../clock";
import type { Pod } from "../types/core/v1/types";
import { Api } from "./api";

describe("Api", () => {
  let api: Api;

  beforeEach(() => {
    api = new Api(new Clock());
  });

  describe("pods", () => {
    const pod: Pod = {
      kind: "Pod",
      apiVersion: "v1",
      metadata: {
        name: "pod-1",
      },
    };

    it("should be able to store and retrieve pods", async () => {
      await api.v1.pods.create(pod);
      const retrievedPod = await api.v1.pods.get("pod-1");
      expect(retrievedPod).toEqual(pod);
    });

    it("should be able to generate names", async () => {
      const pod: Pod = {
        kind: "Pod",
        apiVersion: "v1",
        metadata: {
          generateName: "generated-",
        },
      };

      const created = await api.v1.pods.create(pod);
      expect(created.metadata).toBeDefined();
      expect(created.metadata?.name).toMatch(/^generated-.+$/);
    });

    it("should refuse to create pods with duplicate names", async () => {
      await api.v1.pods.create(pod);
      await expect(api.v1.pods.create(pod)).rejects.toThrow("already exists");
    });

    it("should be able to delete pods", async () => {
      await api.v1.pods.create(pod);
      const deleted = await api.v1.pods.delete("pod-1");
      expect(deleted).toBe(true);

      const retrievedPod = await api.v1.pods.get("pod-1");
      expect(retrievedPod).toBeUndefined();
    });
  });
});
