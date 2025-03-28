import { debug, error } from "@opennextjs/aws/adapters/logger.js";
import type { OpenNextConfig } from "@opennextjs/aws/types/open-next.js";
import type { OriginalTagCache } from "@opennextjs/aws/types/overrides.js";
import { RecoverableError } from "@opennextjs/aws/utils/error.js";

import { getCloudflareContext } from "../../cloudflare-context.js";

/**
 * An instance of the Tag Cache that uses a D1 binding (`NEXT_TAG_CACHE_D1`) as it's underlying data store.
 *
 * **Tag/path mappings table**
 *
 * Information about the relation between tags and paths is stored in a `tags` table that contains
 * two columns; `tag`, and `path`.
 *
 * This table should be populated using an SQL file that is generated during the build process.
 *
 * **Tag revalidations table**
 *
 * Revalidation times for tags are stored in a `revalidations` table that contains two columns; `tags`,
 * and `revalidatedAt`.
 */
class D1TagCache implements OriginalTagCache {
  public readonly name = "d1-tag-cache";

  public async getByPath(rawPath: string): Promise<string[]> {
    const { isDisabled, db } = this.getConfig();
    if (isDisabled) return [];

    const path = this.getCacheKey(rawPath);

    try {
      const { success, results } = await db
        .prepare(`SELECT tag FROM tags WHERE path = ?`)
        .bind(path)
        .all<{ tag: string }>();

      if (!success) throw new RecoverableError(`D1 select failed for ${path}`);

      const tags = results?.map((item) => this.removeBuildId(item.tag));

      debug("tags for path", path, tags);
      return tags;
    } catch (e) {
      error("Failed to get tags by path", e);
      return [];
    }
  }

  public async getByTag(rawTag: string): Promise<string[]> {
    const { isDisabled, db } = this.getConfig();
    if (isDisabled) return [];

    const tag = this.getCacheKey(rawTag);

    try {
      const { success, results } = await db
        .prepare(`SELECT path FROM tags WHERE tag = ?`)
        .bind(tag)
        .all<{ path: string }>();

      if (!success) throw new RecoverableError(`D1 select failed for ${tag}`);

      const paths = results?.map((item) => this.removeBuildId(item.path));

      debug("paths for tag", tag, paths);
      return paths;
    } catch (e) {
      error("Failed to get by tag", e);
      return [];
    }
  }

  public async getLastModified(path: string, lastModified?: number): Promise<number> {
    const { isDisabled, db } = this.getConfig();
    if (isDisabled) return lastModified ?? Date.now();

    try {
      const { success, results } = await db
        .prepare(
          `SELECT revalidations.tag FROM revalidations
            INNER JOIN tags ON revalidations.tag = tags.tag
            WHERE tags.path = ? AND revalidations.revalidatedAt > ?;`
        )
        .bind(this.getCacheKey(path), lastModified ?? 0)
        .all<{ tag: string }>();

      if (!success) throw new RecoverableError(`D1 select failed for ${path} - ${lastModified ?? 0}`);

      debug("revalidatedTags", results);
      return results?.length > 0 ? -1 : (lastModified ?? Date.now());
    } catch (e) {
      error("Failed to get revalidated tags", e);
      return lastModified ?? Date.now();
    }
  }

  public async writeTags(tags: { tag: string; path: string; revalidatedAt?: number }[]): Promise<void> {
    const { isDisabled, db } = this.getConfig();
    if (isDisabled || tags.length === 0) return;

    try {
      const uniqueTags = new Set<string>();
      const results = await db.batch(
        tags
          .map(({ tag, path, revalidatedAt }) => {
            if (revalidatedAt === 1) {
              // new tag/path mapping from set
              return db
                .prepare(`INSERT INTO tags (tag, path) VALUES (?, ?)`)
                .bind(this.getCacheKey(tag), this.getCacheKey(path));
            }

            if (!uniqueTags.has(tag) && revalidatedAt !== -1) {
              // tag was revalidated
              uniqueTags.add(tag);
              return db
                .prepare(`INSERT INTO revalidations (tag, revalidatedAt) VALUES (?, ?)`)
                .bind(this.getCacheKey(tag), revalidatedAt ?? Date.now());
            }
          })
          .filter((stmt) => !!stmt)
      );

      const failedResults = results.filter((res) => !res.success);

      if (failedResults.length > 0) {
        throw new RecoverableError(`${failedResults.length} tags failed to write`);
      }
    } catch (e) {
      error("Failed to batch write tags", e);
    }
  }

  private getConfig() {
    const cfEnv = getCloudflareContext().env;
    const db = cfEnv.NEXT_TAG_CACHE_D1;

    if (!db) debug("No D1 database found");

    const isDisabled = !!(globalThis as unknown as { openNextConfig: OpenNextConfig }).openNextConfig
      .dangerous?.disableTagCache;

    return !db || isDisabled
      ? { isDisabled: true as const }
      : {
          isDisabled: false as const,
          db,
        };
  }

  protected removeBuildId(key: string) {
    return key.replace(`${this.getBuildId()}/`, "");
  }

  protected getCacheKey(key: string) {
    return `${this.getBuildId()}/${key}`.replaceAll("//", "/");
  }

  protected getBuildId() {
    return process.env.NEXT_BUILD_ID ?? "no-build-id";
  }
}

export default new D1TagCache();
