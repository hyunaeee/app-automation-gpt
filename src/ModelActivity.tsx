import { Check, ChevronDown, CircleSlash, Cpu, Image, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ModelUsage, Project } from './types';
import './model-activity.css';

const labels: Record<ModelUsage['capability'], string> = { planning: '기획', coding: '코드 작성', debugging: '오류 수정', image: '이미지 제작', validation: '실행 검증' };
const statuses: Record<ModelUsage['status'], string> = { completed: '완료', skipped: '호출 안 함', failed: '실패' };

export default function ModelActivity({ project }: { project: Project }) {
  const entries = project.modelUsage || [];
  if (!entries.length) return null;
  const completed = entries.filter(entry => entry.status === 'completed').length;
  return <details className="model-activity">
    <summary><span className="model-activity-symbol"><Cpu size={16} /></span><span><b>사용한 모델과 도구</b><small>완료한 작업 {completed}개 · 실제 실행 기록</small></span><ChevronDown size={15} className="model-activity-chevron" /></summary>
    <div className="model-activity-list">
      {entries.map((entry, index) => <div className={`model-activity-row ${entry.status}`} key={`${entry.stage}-${index}`}>
        <span className="model-activity-icon">{entry.capability === 'image' ? <Image size={16} /> : entry.capability === 'validation' ? <ShieldCheck size={16} /> : <Cpu size={16} />}</span>
        <div className="model-activity-description"><b>{labels[entry.capability] || entry.stage}</b><code>{entry.model || (entry.capability === 'validation' ? '실행 도구' : entry.status === 'skipped' ? '모델 호출 없음' : project.authMode === 'codex-subscription' && entry.capability !== 'image' ? 'Codex 기본 모델' : '모델 ID 기록 없음')}</code>{entry.detail && <p>{entry.detail}</p>}</div>
        <span className="model-activity-status">{entry.status === 'completed' ? <Check size={12} /> : entry.status === 'failed' ? <TriangleAlert size={12} /> : <CircleSlash size={12} />}{statuses[entry.status]}</span>
      </div>)}
    </div>
  </details>;
}
