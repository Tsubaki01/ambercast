/**
 * Declares the persistence boundary for text, binary artifacts, and directory
 * preparation. Adapters provide the filesystem-specific mechanics while this
 * contract keeps callers independent of a particular storage backend.
 */
/**
 * Storage operations required by ambercast artifacts and run data.
 *
 * Text is always UTF-8 so callers cannot accidentally make artifact encoding
 * a backend-specific choice. Path normalization, listing depth and order, and
 * overwrite behavior are shared behavioral contracts rather than assumptions
 * each implementation may make independently.
 */
export interface StorageAdapter {
  /**
   * Reads a UTF-8 text file.
   *
   * @param path - The storage path to read.
   * @returns The file contents.
   */
  readText(path: string): Promise<string>;

  /**
   * Writes UTF-8 text to a storage path.
   *
   * @param path - The storage path to write.
   * @param content - The text to persist.
   */
  writeText(path: string, content: string): Promise<void>;

  /**
   * Writes binary data without converting it through a text encoding.
   *
   * @param path - The storage path to write.
   * @param content - The bytes to persist.
   */
  writeBinary(path: string, content: Uint8Array): Promise<void>;

  /**
   * Determines whether a path currently exists.
   *
   * @param path - The storage path to inspect.
   * @returns Whether the path exists.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Lists files held by a directory according to the shared storage contract.
   *
   * @param dir - The directory to list.
   * @returns The paths selected by the adapter's contract-defined listing.
   */
  listFiles(dir: string): Promise<readonly string[]>;

  /**
   * Ensures a directory is available for later writes.
   *
   * @param dir - The directory to create or retain.
   */
  ensureDir(dir: string): Promise<void>;
}
