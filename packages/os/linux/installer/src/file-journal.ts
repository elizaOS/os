import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type InstallJournal, InstallRecoveryRequiredError } from "./executor";
import type { InstallJournalEntry } from "./types";

const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const OWNER_FILE_MODE = 0o600;

function recoveryRequired(message: string): InstallRecoveryRequiredError {
  return new InstallRecoveryRequiredError(`Install journal: ${message}`);
}

function operatingUid(): number {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw recoveryRequired("Linux effective-user identity is unavailable.");
  }
  return uid;
}

export class DurableFileInstallJournal implements InstallJournal {
  readonly directory: string;

  constructor(directory: string) {
    if (!directory.trim() || !isAbsolute(directory)) {
      throw new Error("Install journal directory must be an absolute path.");
    }
    this.directory = resolve(directory);
  }

  private paths(planId: string): { journal: string; lock: string } {
    if (!PLAN_ID_PATTERN.test(planId)) {
      throw recoveryRequired("plan ID is not a canonical SHA-256 digest.");
    }
    return {
      journal: join(this.directory, `${planId}.jsonl`),
      lock: join(this.directory, `${planId}.lock`),
    };
  }

  private async assertDirectory(): Promise<void> {
    let stats: Stats;
    try {
      stats = await lstat(this.directory);
    } catch (error) {
      throw recoveryRequired(
        `directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.uid !== operatingUid() ||
      (stats.mode & 0o077) !== 0 ||
      (await realpath(this.directory)) !== this.directory
    ) {
      throw recoveryRequired(
        "directory must be canonical, owner-controlled, and inaccessible to group/other users.",
      );
    }
  }

  private async assertUnlocked(lockPath: string): Promise<void> {
    try {
      await lstat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw recoveryRequired("could not inspect the single-writer lock.");
    }
    throw recoveryRequired(
      "single-writer lock exists; an interrupted or concurrent writer requires explicit recovery.",
    );
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private parseRecords(
    planId: string,
    serialized: string,
  ): InstallJournalEntry[] {
    if (!serialized) return [];
    if (!serialized.endsWith("\n")) {
      throw recoveryRequired("journal ends with a partial record.");
    }
    return serialized
      .slice(0, -1)
      .split("\n")
      .map((line, index) => {
        try {
          const entry = JSON.parse(line) as InstallJournalEntry;
          if (
            typeof entry !== "object" ||
            entry === null ||
            entry.planId !== planId
          ) {
            throw new Error("record identity mismatch");
          }
          return entry;
        } catch (error) {
          throw recoveryRequired(
            `record ${index} is invalid: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  }

  async read(planId: string): Promise<InstallJournalEntry[]> {
    const paths = this.paths(planId);
    await this.assertDirectory();
    await this.assertUnlocked(paths.lock);
    let handle: FileHandle;
    try {
      handle = await open(
        paths.journal,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw recoveryRequired(
        "journal file could not be opened without following links.",
      );
    }
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== operatingUid() ||
        (stats.mode & 0o777) !== OWNER_FILE_MODE ||
        stats.size > MAX_JOURNAL_BYTES
      ) {
        throw recoveryRequired(
          "journal must be a bounded, owner-only regular file with one link.",
        );
      }
      return this.parseRecords(planId, await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }

  async append(entry: InstallJournalEntry): Promise<void> {
    const paths = this.paths(entry.planId);
    await this.assertDirectory();
    await this.assertUnlocked(paths.lock);
    let encoded: string;
    try {
      encoded = JSON.stringify(entry);
    } catch (error) {
      throw recoveryRequired(
        `record is not serializable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const serialized = Buffer.from(`${encoded}\n`, "utf8");
    if (serialized.length > 64 * 1024) {
      throw recoveryRequired("record exceeds the maximum atomic append size.");
    }
    const lock = await open(
      paths.lock,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      OWNER_FILE_MODE,
    ).catch(() => {
      throw recoveryRequired("failed to acquire the single-writer lock.");
    });
    await lock.sync();
    await lock.close();
    await this.syncDirectory();
    let writeStarted = false;
    try {
      const journal = await open(
        paths.journal,
        constants.O_CREAT |
          constants.O_APPEND |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        OWNER_FILE_MODE,
      ).catch(() => {
        throw recoveryRequired("journal file could not be opened for append.");
      });
      try {
        const stats = await journal.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.uid !== operatingUid() ||
          (stats.mode & 0o777) !== OWNER_FILE_MODE ||
          stats.size + serialized.length > MAX_JOURNAL_BYTES
        ) {
          throw recoveryRequired(
            "journal append target is not a bounded, owner-only regular file with one link.",
          );
        }
        const existing = this.parseRecords(
          entry.planId,
          await journal.readFile("utf8"),
        );
        if (
          entry.sequence !== existing.length ||
          entry.previousDigest !== (existing.at(-1)?.digest ?? null)
        ) {
          throw recoveryRequired(
            "record is stale against the journal head held by the writer lock.",
          );
        }
        writeStarted = true;
        const result = await journal.write(
          serialized,
          0,
          serialized.length,
          null,
        );
        if (result.bytesWritten !== serialized.length) {
          throw recoveryRequired("journal record was only partially appended.");
        }
        await journal.sync();
      } finally {
        await journal.close();
      }
      await this.syncDirectory();
    } catch (error) {
      if (!writeStarted) {
        await unlink(paths.lock);
        await this.syncDirectory();
      }
      throw error;
    }
    await unlink(paths.lock);
    await this.syncDirectory();
  }
}
