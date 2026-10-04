import type { AppConfig, Project, ProjectKind, AuthSession, AndroidBuild, ProjectEstimate, AgentDelivery, WorkflowMode } from './types';

export type CredentialStatus = {
  connected: boolean;
  source: 'personal' | 'server' | 'none';
  model: string;
  maskedKey: string | null;
  expiresAt: string | null;
  storage: 'encrypted-server';
  validated: boolean;
  provider?:'openai';
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('launchpad:auth-expired'));
    throw new Error(body?.error || `요청을 처리하지 못했습니다 (${response.status}).`);
  }
  return body as T;
}

export const api = {
  authSession: async (): Promise<AuthSession> => {
    const response = await fetch('/api/auth/session');
    if (response.status === 404) return { authenticated: true, required: false };
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '워크스페이스 연결을 확인하지 못했어요.');
    if (data.configured === false) throw new Error('워크스페이스가 아직 준비되지 않았어요. Vercel 환경 변수에 WORKSPACE_PASSWORD(12자 이상)와 SESSION_SECRET(32자 이상)을 설정한 후 다시 배포해 주세요.');
    return data;
  },
  login: (password: string) => request<{ authenticated: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<unknown>('/auth/logout', { method: 'POST' }),
  config: () => request<AppConfig>('/config'),
  credentials: () => request<CredentialStatus>('/credentials'),
  connectKey: (apiKey: string, model: string) => request<CredentialStatus>('/credentials', { method: 'PUT', body: JSON.stringify({ apiKey, model,provider:'openai' }) }),
  disconnectKey: () => request<CredentialStatus>('/credentials', { method: 'DELETE' }),
  projects: () => request<Project[]>('/projects'),
  project: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`),
  create: (prompt: string, kind: ProjectKind, agentDelivery?:AgentDelivery, workflowMode:WorkflowMode='auto') => request<Project>('/projects', { method: 'POST', body: JSON.stringify({ prompt, kind, workflowMode, ...(kind==='ai-agent'?{agentDelivery:agentDelivery||'web'}:{}) }) }),
  review: (id:string, reviewId:string, action:'approve'|'revise', feedback?:string) => request<Project>(`/projects/${encodeURIComponent(id)}/review`, { method:'POST', body:JSON.stringify({reviewId,action,...(feedback?{feedback}:{})}) }),
  estimate:(prompt:string,kind:ProjectKind,agentDelivery?:AgentDelivery)=>request<ProjectEstimate>('/estimate',{method:'POST',body:JSON.stringify({prompt,kind,...(kind==='ai-agent'?{agentDelivery:agentDelivery||'web'}:{})})}),
  revise:(id:string,prompt:string)=>request<Project>(`/projects/${encodeURIComponent(id)}/revise`,{method:'POST',body:JSON.stringify({prompt})}),
  cancel: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  retry: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  launch: (id: string) => request<{ url: string }>(`/projects/${encodeURIComponent(id)}/launch`, { method: 'POST' }),
  android:(id:string)=>request<AndroidBuild>(`/projects/${encodeURIComponent(id)}/android`),
  buildAndroid:(id:string)=>request<AndroidBuild>(`/projects/${encodeURIComponent(id)}/android/build`,{method:'POST'}),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}

export function safePreviewUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !!url.port;
    const sandbox = url.protocol === 'https:' && url.hostname.endsWith('.vercel.run');
    if ((!local && !sandbox) || url.origin === window.location.origin || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}
