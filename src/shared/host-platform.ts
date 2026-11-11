import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The host helpers that shared modules take from whichever host loaded pit. The Pi extension
 * installs Pi's own, so pit's file writes queue with Pi's edit and write tools and Pi's configured
 * directories apply. Hosts without Pi, such as pi-durable, keep these Node implementations, which
 * follow Pi's defaults.
 */
export interface HostPlatform {
  /** The agent directory: user functions and the user-wide `pit.json` live here. */
  agentDir(): string;
  /** The project configuration directory name, such as `.pi`. */
  readonly configDirName: string;
  /** Formats a byte count the way Pi reports sizes, such as `50.0KB`. */
  formatSize(bytes: number): string;
  /** Serializes mutations of one file; mutations of different files still run in parallel. */
  withFileMutationQueue<T>(path: string, task: () => Promise<T>): Promise<T>;
}

const AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";
const CONFIG_DIR_NAME = ".pi";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const mutationQueues = new Map<string, Promise<void>>();
let registrations: Promise<void> = Promise.resolve();

async function mutationQueueKey(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return resolved;
    /* v8 ignore next -- realpath fails otherwise only for unreadable paths, which Pi rejects too. */
    throw error;
  }
}

async function withFileMutationQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  // Registrations run in order, so two calls for one file queue in the order they were made.
  const registration = registrations.then(async () => {
    const key = await mutationQueueKey(path);
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    const queued = previous.then(() => current);
    mutationQueues.set(key, queued);
    return { key, previous, queued, release };
  });
  registrations = registration.then(
    () => undefined,
    /* v8 ignore next -- a failed registration rejects its own call and must not block others. */
    () => undefined,
  );
  const { key, previous, queued, release } = await registration;
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

/** Pi's defaults, for hosts that do not install their own platform. */
export const NODE_HOST_PLATFORM: HostPlatform = {
  agentDir: () => {
    const configured = process.env[AGENT_DIR_VARIABLE];
    return configured ? expandHome(configured) : join(homedir(), CONFIG_DIR_NAME, "agent");
  },
  configDirName: CONFIG_DIR_NAME,
  formatSize,
  withFileMutationQueue,
};

let installed: HostPlatform = NODE_HOST_PLATFORM;

/** The platform of the host that loaded pit. */
export function hostPlatform(): HostPlatform {
  return installed;
}

/** Replaces the platform; the Pi extension installs Pi's helpers when it loads. */
export function installHostPlatform(platform: HostPlatform): void {
  installed = platform;
}
