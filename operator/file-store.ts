import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HolderRewardsStore } from "@interest-protocol/blast-holder-rewards-sdk/operator";

/** Atomic replacement keeps the durable checkpoint watermark with the balances it describes. */
export async function writeOperatorJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(
      `${JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Local single-writer lock. After a hard crash, an operator must remove the stale lock. */
export async function withOperatorLock<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, ".lock");
  try {
    await mkdir(lock);
  } catch (error) {
    throw new Error(`operator lock unavailable: ${lock}`, { cause: error });
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

export async function readOperatorJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/**
 * One JSON file per key under `directory`. Single host only: the lock is a
 * local directory, so two hosts sharing a store need a database instead.
 */
export function fileHolderRewardsStore(directory: string): HolderRewardsStore {
  const path = (key: string) => join(directory, `${key}.json`);
  return {
    async read(key) {
      try {
        return await readOperatorJson(path(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    write: (key, value) => writeOperatorJson(path(key), value),
    remove: (key) => rm(path(key), { force: true }),
    withLock: (action) => withOperatorLock(directory, action),
  };
}
