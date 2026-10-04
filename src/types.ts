export type ProjectKind = 'web-app' | 'ai-agent' | 'mobile-app';
export type AgentDelivery = 'web' | 'api' | 'mcp';
export type WorkflowMode = 'auto' | 'guided';
export type ReviewStage = 'requirements' | 'features' | 'architecture';
export interface WorkflowReview { id: string; stage: ReviewStage; createdAt: string }
export interface ReviewDecision { stage: ReviewStage; action: 'approve' | 'revise'; feedback?: string; createdAt: string }
export interface AndroidBuild { status:'idle'|'building'|'ready'|'failed'; message?:string; logs:string[]; filename?:string; size?:number; sha256?:string; builtAt?:string }
export interface AuthSession { authenticated:boolean; required:boolean; google?:boolean; user?:{ownerId:string;name:string;email:string;picture?:string}|null }
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ProjectStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export interface Stage { id: string; label: string; status: StageStatus; detail?: string; startedAt?: string; completedAt?: string }
export interface LogEntry { id: string; timestamp: string; level: 'info' | 'success' | 'error' | 'warn'; stage: string; message: string }
export interface Feature { name: string; description: string; priority: 'core' | 'extra' }
export interface Plan { name: string; summary: string; audience: string; features: Feature[]; assumptions: string[]; stack: { name: string; role: string }[]; fileTree: string[] }
export interface GeneratedFile { path: string; content: string; language: string }
export interface Check { name: string; passed: boolean; detail: string }
export interface ModelUsage { stage: string; capability: 'planning' | 'coding' | 'debugging' | 'image' | 'validation'; model: string | null; status: 'completed' | 'skipped' | 'failed'; detail?: string; timestamp?: string }
export interface Project {
  id: string; name: string; prompt: string; kind: ProjectKind; status: ProjectStatus;
  createdAt: string; updatedAt: string; mode: 'local' | 'openai';
  stages: Stage[]; logs: LogEntry[]; plan: Plan | null; files: GeneratedFile[];
  checks: Check[]; previewUrl: string | null; error: string | null; retryCount: number;
  android?:AndroidBuild;
  agentDelivery?:AgentDelivery;
  workflowMode?: WorkflowMode;
  review?: WorkflowReview | null;
  reviewHistory?: ReviewDecision[];
  approvedStages?: ReviewStage[];
  authMode?:'api-key'|'codex-subscription'|'none';
  model?: string;
  modelUsage?: ModelUsage[];
  summaryOnly?: boolean;
  parentProjectId?:string;
  revision?:{number:number;prompt:string;mode:'ai-edit'|'template-copy';message:string};
}
export interface AppConfig { mode: 'local' | 'openai'; provider?:'openai'; authMode?:'api-key'|'codex-subscription'|'none'; model: string | null; modelRouting?: 'automatic'; credentialSource?: 'personal' | 'server' | 'subscription' | 'none'; maxRetries: number; version: string }
export interface ProjectEstimate {
  kind:ProjectKind; provider:string; model:string|null; complexity:string;
  modelRouting?: 'automatic';
  agentDelivery?:AgentDelivery;
  modelCalls:{min:number;max:number}; timeSeconds:{min:number;max:number};
  cost:{currency:'USD';status:'estimated'|'unpriced'|'not-applicable';min:number|null;max:number|null};
  excludedCosts:{id:string;label:string;detail:string}[]; assumptions:string[];
}
