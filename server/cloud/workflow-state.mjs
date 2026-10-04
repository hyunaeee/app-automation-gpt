// Durable workflow state shared by the worker and its mocked infrastructure tests.
export function workerInitialOptions(record, mode) {
  const resumes = mode === 'generate' && record.execution.resumeFromReview === true;
  return {
    initialProjects: mode === 'launch' || resumes ? [record.project] : [],
    ...(resumes ? { resumeIds: [record.project.id] } : {}),
    ...(resumes && record.execution.revisionSeed ? { initialRevisionSeeds: { [record.project.id]: record.execution.revisionSeed } } : {}),
  };
}

export async function publishWorkerSnapshot(store, id, runId, project) {
  let accepted = false;
  const updated = await store.update(id, current => {
    accepted = false;
    if (current.execution.runId !== runId || current.execution.credentialRevoked || ['cancelled', 'failed'].includes(current.project.status)) return null;
    if (current.project.status === 'awaiting_approval' && (project.status !== 'awaiting_approval' || current.project.review?.id !== project.review?.id)) return null;
    accepted = true;
    current.project = { ...project, ...(current.project.android ? { android: current.project.android } : {}) };
    return current;
  });
  if (accepted && ['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(updated.project.status)) {
    // The durable project state itself also makes this lease reclaimable. Do
    // not turn a successful checkpoint into a failure on transient cleanup.
    await store.release(updated.execution.slot, runId).catch(() => {});
  }
  return accepted;
}

export async function requestPausedSandboxStop({ id, runId, origin, token, fetcher = fetch }) {
  if (!origin || !token) return false;
  let url;
  try {
    url = new URL(`/api/internal/projects/${encodeURIComponent(id)}/pause`, origin);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
  } catch { return false; }
  try {
    const response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ runId }),
    });
    return response.ok;
  } catch { return false; }
}
