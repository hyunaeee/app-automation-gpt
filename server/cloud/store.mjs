import * as blobSdk from '@vercel/blob';

const PREFIX = 'launchpad/v1/';
export const isProjectId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');

export function createBlobStore({ blob = blobSdk, token = process.env.BLOB_READ_WRITE_TOKEN } = {}) {
  const options = token ? { token } : {};
  const key = id => {
    if (!isProjectId(id)) throw Object.assign(new Error('올바른 프로젝트 ID가 필요합니다.'), { status: 400 });
    return `${PREFIX}projects/${id}.json`;
  };
  async function readPath(pathname) {
    const result = await blob.get(pathname, { ...options, access: 'private', useCache: false });
    if (!result) return null;
    return { value: JSON.parse(await new Response(result.stream).text()), etag: result.blob.etag };
  }
  async function writePath(pathname, value, etag) {
    return blob.put(pathname, JSON.stringify(value), {
      ...options, access: 'private', addRandomSuffix: false, allowOverwrite: Boolean(etag),
      ...(etag ? { ifMatch: etag } : {}), contentType: 'application/json', cacheControlMaxAge: 60,
    });
  }
  return {
    read: id => readPath(key(id)),
    write: (record, etag) => writePath(key(record.project.id), record, etag),
    async list() {
      const records = []; let cursor;
      do {
        const page = await blob.list({ ...options, prefix: `${PREFIX}projects/`, limit: 1000, ...(cursor ? { cursor } : {}) });
        const rows = await Promise.all(page.blobs.map(item => readPath(item.pathname)));
        records.push(...rows.filter(Boolean).map(item => item.value)); cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return records.sort((a, b) => b.project.createdAt.localeCompare(a.project.createdAt));
    },
    async update(id, mutate, attempts = 5) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const current = await readPath(key(id));
        if (!current) return null;
        const next = await mutate(structuredClone(current.value));
        if (!next) return current.value;
        try { await writePath(key(id), next, current.etag); return next; }
        catch (error) { if (error.name !== 'BlobPreconditionFailedError' || attempt === attempts - 1) throw error; }
      }
    },
    async reserve(runId, projectId, expiresAt, max = 3) {
      for (let index = 0; index < max; index++) {
        const pathname = `${PREFIX}slots/${index}.json`;
        const current = await readPath(pathname);
        if (current && Date.parse(current.value.expiresAt) > Date.now()) {
          const project = await readPath(key(current.value.projectId));
          if (!project || ['queued', 'running'].includes(project.value.project.status)) continue;
        }
        try {
          await writePath(pathname, { runId, projectId, expiresAt }, current?.etag);
          return index;
        } catch (error) {
          if (error.name !== 'BlobPreconditionFailedError' && !/already exists/i.test(error.message)) throw error;
        }
      }
      throw Object.assign(new Error(`동시에 실행할 수 있는 프로젝트는 ${max}개입니다. 진행 중인 작업이 끝나면 다시 시도해 주세요.`), { status: 429 });
    },
    async release(slot, runId) {
      if (!Number.isInteger(slot)) return;
      const pathname = `${PREFIX}slots/${slot}.json`; const current = await readPath(pathname);
      if (current?.value.runId !== runId) return;
      try { await writePath(pathname, { ...current.value, expiresAt: new Date(0).toISOString() }, current.etag); }
      catch (error) { if (error.name !== 'BlobPreconditionFailedError') throw error; }
    },
  };
}
