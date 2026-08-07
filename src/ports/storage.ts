/**
 * Declares the persistence boundary for text, binary artifacts, and directory
 * preparation.
 */

/**
 * Storage operations for ambercast artifacts and run data.
 *
 * Text operations always use UTF-8. Paths and directory names are opaque
 * strings: this port does not resolve `.` or `..`, or canonicalize separators,
 * so callers must supply paths already valid for their chosen layout.
 *
 * @remarks
 * Path construction belongs to the layout resolver. Keeping this boundary as
 * a thin I/O primitive avoids creating a second, potentially divergent set of
 * path-normalization rules in every storage adapter.
 *
 * Names starting with `.ambercast-tmp-` are reserved by the Storage layer for
 * staging. Implementations that stage writes use this prefix, and callers must
 * not create paths using it. The prefix may appear in `listFiles` results and,
 * after abrupt termination of a write, may persist; callers must ignore it.
 */
export interface StorageAdapter {
  /**
   * Reads a UTF-8 regular file.
   *
   * @param path - Opaque path of the file to read.
   * @returns The decoded text content.
   * @throws An `Error` if `path` is missing or names a directory.
   */
  readText(path: string): Promise<string>;

  /**
   * Writes UTF-8 text to a file with atomic visibility.
   *
   * Missing parent directories are created automatically. While a write is in
   * progress, readers of `path` receive either its complete previous content
   * or its complete new content, never a partial write. Existing content is
   * replaced, and this is the only write mode: callers cannot opt out of
   * atomicity or request a faster non-atomic alternative.
   *
   * @param path - Opaque path of the file to write.
   * @param content - Text to encode as UTF-8.
   * @throws An `Error` if `path` names an existing directory.
   * @throws If the backend cannot create parents or write the file.
   *
   * @remarks
   * An implementation that creates temporary artifacts attempts to remove
   * them when its write operation reports a failure. Abrupt process
   * termination, including a crash, `SIGKILL`, or power loss, can prevent that
   * cleanup and may leave an implementation-specific artifact behind; this and
   * `fsync`-based power-loss durability are outside this contract.
   *
   * The same-directory, same-volume staging assumption of an implementation
   * that relies on filesystem rename for atomicity is a caveat for implementers
   * and deployers, not a runtime-checked invariant.
   */
  writeText(path: string, content: string): Promise<void>;

  /**
   * Reads a regular file as its original bytes.
   *
   * @param path - Opaque path of the file to read.
   * @returns The file bytes without text decoding.
   * @throws An `Error` if `path` is missing or names a directory.
   */
  readBinary(path: string): Promise<Uint8Array>;

  /**
   * Writes binary data to a file with atomic visibility.
   *
   * Missing parent directories are created automatically. While a write is in
   * progress, readers of `path` receive either its complete previous content
   * or its complete new content, never a partial write. Existing content is
   * replaced, and this is the only write mode: callers cannot opt out of
   * atomicity or request a faster non-atomic alternative.
   *
   * @param path - Opaque path of the file to write.
   * @param content - Bytes to persist.
   * @throws An `Error` if `path` names an existing directory.
   * @throws If the backend cannot create parents or write the file.
   *
   * @remarks
   * An implementation that creates temporary artifacts attempts to remove
   * them when its write operation reports a failure. Abrupt process
   * termination, including a crash, `SIGKILL`, or power loss, can prevent that
   * cleanup and may leave an implementation-specific artifact behind; this and
   * `fsync`-based power-loss durability are outside this contract.
   *
   * The same-directory, same-volume staging assumption of an implementation
   * that relies on filesystem rename for atomicity is a caveat for implementers
   * and deployers, not a runtime-checked invariant.
   */
  writeBinary(path: string, content: Uint8Array): Promise<void>;

  /**
   * Checks whether a path names a regular file.
   *
   * @param path - Opaque path to inspect.
   * @returns `true` only for an existing regular file. Missing paths and
   * directories both resolve to `false`; this method never rejects.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Lists regular files directly inside a directory.
   *
   * `.ambercast-tmp-` names may appear in results; callers must ignore them as
   * described in `StorageAdapter`'s `@remarks`.
   *
   * @param dir - Opaque directory path to inspect; use `''` for the root
   * directory.
   * @returns Lexicographically ascending bare file names. Subdirectories are
   * excluded, listing is not recursive, and both missing and empty directories
   * resolve to an empty array.
   * @throws If an existing directory cannot be listed.
   */
  listFiles(dir: string): Promise<readonly string[]>;

  /**
   * Creates a directory for later use when it does not already exist.
   *
   * @param dir - Opaque directory path to create; use `''` for the root
   * directory.
   * @returns Resolves without effect when the directory already exists.
   * @throws If the backend cannot create the directory.
   */
  ensureDir(dir: string): Promise<void>;
}
