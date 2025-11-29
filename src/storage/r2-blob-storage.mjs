// ABOUTME: R2 blob storage adapter for blossom-server-sdk
// ABOUTME: Implements IBlobStorage interface using Cloudflare R2

/**
 * R2 storage adapter for Blossom blobs
 * Implements the IBlobStorage interface from blossom-server-sdk
 */
export class R2BlobStorage {
  constructor(r2Bucket) {
    this.r2 = r2Bucket;
  }

  async setup() {
    // R2 doesn't require setup
    return;
  }

  async hasBlob(sha256) {
    try {
      // Check new path first
      const obj = await this.r2.head(`blobs/${sha256}`);
      if (obj !== null) return true;
    } catch {}

    try {
      // Fallback to old video path for backward compatibility
      const oldObj = await this.r2.head(`videos/${sha256}.mp4`);
      if (oldObj !== null) return true;
    } catch {}

    try {
      // Fallback to root level mp4
      const rootMp4 = await this.r2.head(`${sha256}.mp4`);
      if (rootMp4 !== null) return true;
    } catch {}

    try {
      // Fallback to root level jpg (thumbnails)
      const rootJpg = await this.r2.head(`${sha256}.jpg`);
      return rootJpg !== null;
    } catch {
      return false;
    }
  }

  async writeBlob(sha256, stream, mimeType, owner = '', uid = '', proofModeVerified = null) {
    const key = `blobs/${sha256}`;

    const customMetadata = {
      sha256: sha256,
      uploadedAt: new Date().toISOString(),
      owner: owner,
      uid: uid
    };

    // Add ProofMode verification metadata if available
    if (proofModeVerified) {
      customMetadata.proofmode_verified = proofModeVerified.verified ? 'true' : 'false';
      customMetadata.proofmode_level = proofModeVerified.level || 'unverified';
      if (proofModeVerified.deviceFingerprint) {
        customMetadata.proofmode_fingerprint = proofModeVerified.deviceFingerprint;
      }
    }

    await this.r2.put(key, stream, {
      httpMetadata: {
        contentType: mimeType || 'application/octet-stream',
        cacheControl: 'public, max-age=31536000, immutable'
      },
      customMetadata
    });

    return true;
  }

  async readBlob(sha256, options = {}) {
    const { range, ctx } = options;

    // Build R2 get options
    const r2Options = {};
    if (range) {
      r2Options.range = range;
    }

    // Try new path first (optimal)
    let obj = await this.r2.get(`blobs/${sha256}`, r2Options);
    let needsMigration = false;
    let sourceKey = null;

    // Fallback to old path for backward compatibility
    if (!obj) {
      obj = await this.r2.get(`videos/${sha256}.mp4`, r2Options);
      if (obj) {
        needsMigration = true;
        sourceKey = `videos/${sha256}.mp4`;
      }
    }

    // Fallback to root level (old old path)
    if (!obj) {
      obj = await this.r2.get(`${sha256}.mp4`, r2Options);
      if (obj) {
        needsMigration = true;
        sourceKey = `${sha256}.mp4`;
      }
    }

    // Fallback to root level .jpg (thumbnails stored by bunny-webhook)
    if (!obj) {
      obj = await this.r2.get(`${sha256}.jpg`, r2Options);
      if (obj) {
        needsMigration = true;
        sourceKey = `${sha256}.jpg`;
      }
    }

    if (!obj) {
      return null;
    }

    // Lazy migration: copy to optimal path for future requests
    // Only do this for full file reads (not range requests) to avoid partial copies
    if (needsMigration && !range) {
      // Clone the body for migration (need to read it twice)
      const [bodyForResponse, bodyForMigration] = obj.body.tee();

      // Fire-and-forget migration (don't block response)
      const migrationPromise = this.r2.put(`blobs/${sha256}`, bodyForMigration, {
        httpMetadata: {
          contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
          cacheControl: 'public, max-age=31536000, immutable'
        },
        customMetadata: {
          sha256: sha256,
          migratedFrom: sourceKey,
          migratedAt: new Date().toISOString()
        }
      }).then(() => {
        console.log(`[Migration] Copied ${sourceKey} -> blobs/${sha256}`);
      }).catch(err => {
        console.error(`[Migration] Failed to copy ${sourceKey}:`, err);
      });

      // Ensure migration completes even after response is sent
      if (ctx) {
        ctx.waitUntil(migrationPromise);
      }

      return {
        body: bodyForResponse,
        size: obj.size,
        type: obj.httpMetadata?.contentType || 'application/octet-stream',
        etag: obj.etag,
        range: obj.range
      };
    }

    return {
      body: obj.body,
      size: obj.size,
      type: obj.httpMetadata?.contentType || 'application/octet-stream',
      etag: obj.etag,
      range: obj.range  // R2 returns range info if range was requested
    };
  }

  async removeBlob(sha256) {
    const key = `blobs/${sha256}`;
    await this.r2.delete(key);
    return true;
  }
}
