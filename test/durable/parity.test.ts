import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR_NAME, formatSize, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APPLY_STAGED_EDITS_HOOK } from "../../src/durable/context/apply.js";
import { createPitDurableExtension } from "../../src/durable/index.js";
import { NODE_HOST_PLATFORM } from "../../src/shared/host-platform.js";
import { cleanupHarness, setupHarness, tool } from "../support/extension-fixture.js";

describe("the pi-durable typescript tool", () => {
  beforeEach(setupHarness);
  afterEach(cleanupHarness);

  it("declares the parameters and description of Pi's tool", () => {
    const [durable] = createPitDurableExtension().tools ?? [];
    expect(durable?.parameters).toEqual(JSON.parse(JSON.stringify(tool.parameters)));
    expect(durable?.description.startsWith(tool.description)).toBe(true);
  });
});

describe("the Node host platform", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([0, 1023, 1024, 51_200, 1_048_575, 1_048_576, 5 * 1024 * 1024 + 1])(
    "formats %i bytes as Pi does",
    (bytes) => {
      expect(NODE_HOST_PLATFORM.formatSize(bytes)).toBe(formatSize(bytes));
    },
  );

  it.each([
    ["an absolute agent directory", "/agents/work"],
    ["a home-relative agent directory", "~/agents/work"],
    ["the home directory", "~"],
  ])("resolves %s from PI_CODING_AGENT_DIR as Pi does", (_name, configured) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", configured);
    expect(NODE_HOST_PLATFORM.agentDir()).toBe(getAgentDir());
  });

  it("defaults to Pi's agent and configuration directories", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    expect(NODE_HOST_PLATFORM.agentDir()).toBe(join(homedir(), ".pi", "agent"));
    expect(NODE_HOST_PLATFORM.agentDir()).toBe(getAgentDir());
    expect(NODE_HOST_PLATFORM.configDirName).toBe(CONFIG_DIR_NAME);
  });

  describe("file mutation queue", () => {
    let directory: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "pit-queue-"));
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("serializes mutations of one file and runs other files' in parallel", async () => {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const first = NODE_HOST_PLATFORM.withFileMutationQueue(join(directory, "a.txt"), async () => {
        order.push("a1 start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("a1 end");
      });
      const second = NODE_HOST_PLATFORM.withFileMutationQueue(
        join(directory, "sub/../a.txt"),
        async () => {
          order.push("a2");
        },
      );
      const other = NODE_HOST_PLATFORM.withFileMutationQueue(join(directory, "b.txt"), async () => {
        order.push("b");
      });
      await other;
      expect(order).toEqual(["a1 start", "b"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["a1 start", "b", "a1 end", "a2"]);
    });

    it("queues a path under a file by its resolved name", async () => {
      await writeFile(join(directory, "file"), "");
      await expect(
        NODE_HOST_PLATFORM.withFileMutationQueue(
          join(directory, "file/child"),
          async () => "queued",
        ),
      ).resolves.toBe("queued");
    });

    it("releases the queue after a failed mutation", async () => {
      const path = join(directory, "a.txt");
      await expect(
        NODE_HOST_PLATFORM.withFileMutationQueue(path, async () => {
          throw new Error("write failed");
        }),
      ).rejects.toThrow("write failed");
      await expect(
        NODE_HOST_PLATFORM.withFileMutationQueue(path, async () => "next"),
      ).resolves.toBe("next");
    });
  });
});

describe("pi-durable registrations by name", () => {
  it("hooks the generation task under the name pi-durable registers it with", async () => {
    const { GenerationTask } = await import("@earendil-works/pi-durable");
    expect(APPLY_STAGED_EDITS_HOOK.task).toBe(GenerationTask.definition.name);
  });
});
