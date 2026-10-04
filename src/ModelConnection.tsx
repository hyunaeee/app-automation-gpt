import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck, Unplug } from 'lucide-react';
import { api, errorMessage } from './api';
import type { CredentialStatus } from './api';
import type { AppConfig } from './types';

export default function ModelConnection({ onChange, config }: { onChange: () => Promise<void>; config:AppConfig|null }) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.credentials().then(result => {
      if (active) { setStatus(result); setModel(result.model || 'gpt-4.1-mini'); }
    }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, []);

  const connect = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api.connectKey(key.trim(), model.trim());
      setStatus(result); setKey(''); setVisible(false);
      setMessage('개인 키를 저장했어요. 다음 프로젝트부터 이 연결을 사용합니다.');
      await onChange();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      setStatus(await api.disconnectKey()); setKey(''); setVisible(false);
      setMessage('개인 키 연결과 이 키를 사용하던 실행을 종료했어요. 생성된 소스는 유지됩니다.');
      await onChange();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };

  return <section className="model-connection" aria-labelledby="model-connection-title">
    <div className="connection-section-heading"><span className="connection-key-icon"><KeyRound size={19} /></span><div><h3 id="model-connection-title">나의 AI 연결</h3><p>내 키, 내 모델로 아이디어를 만드세요.</p></div><span className={`connection-pill ${status?.source === 'personal' ? 'personal' : ''}`}>{status?.source === 'personal' ? '개인 키 연결됨' : 'BYOK'}</span></div>

    {status?.source === 'personal' && <div className="connected-key-summary"><Check size={15} /><div><b>{status.maskedKey}</b><span>{status.model}{status.expiresAt && ` · ${new Date(status.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}까지`}</span></div><button className="text-button" onClick={() => { void disconnect(); }} disabled={busy}><Unplug size={13} />연결 해제</button></div>}
    {status?.source === 'server' && <p className="connection-privacy"><ShieldCheck size={14} /><span>현재 워크스페이스 공용 API 키를 사용 중입니다. 개인 키를 연결하면 이후 생성은 본인 계정에 청구됩니다.</span></p>}

    <div className="connection-methods"><div><b>OpenAI API</b><span>개인 키 · 사용량에 따른 과금</span></div><div><b>Codex 구독</b><span>{config?.authMode==='codex-subscription'?'이 컴퓨터의 구독 연결 사용 중':'로컬 Codex 연결 설정 필요'}</span></div></div>
    <form onSubmit={event => { event.preventDefault(); void connect(); }}>
      <label htmlFor="personal-api-key">OpenAI API 키</label>
      <div className="api-key-field"><KeyRound size={15} /><input id="personal-api-key" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={key} onChange={event => { setKey(event.target.value); setMessage(null); }} placeholder={status?.source === 'personal' ? '새 키를 입력하면 연결을 변경합니다' : 'sk-…'} maxLength={1024} required disabled={busy} /><button type="button" className="icon-button" onClick={() => setVisible(value => !value)} aria-label={visible ? 'API 키 숨기기' : 'API 키 보기'}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
      <div className="model-field-row"><div><label htmlFor="personal-model">사용할 모델</label><input id="personal-model" value={model} onChange={event => setModel(event.target.value)} placeholder="예: gpt-5.3-codex" autoComplete="off" spellCheck={false} maxLength={100} required disabled={busy} /></div><button className="primary-button" type="submit" disabled={busy || !status || !key.trim() || !model.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={14} />}{status?.source === 'personal' ? '연결 변경' : '개인 키 연결'}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="connection-success" role="status"><Check size={14} />{message}</p>}
    </form>
    <p className="connection-privacy"><ShieldCheck size={14} /><span>키 사용은 12시간 후 만료됩니다. 암호화해 보관하며 저장한 원문을 다시 표시하지 않습니다. Google 로그인 시 같은 계정에서 연결을 관리합니다.</span></p>
    <div className="connection-billing"><p>API 사용량은 연결한 OpenAI API 계정에 청구됩니다. 키와 모델의 사용 권한은 첫 생성 요청에서 확인합니다.</p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">API 키 관리 <ArrowUpRight size={12} /></a></div>
    <details className="subscription-info"><summary>ChatGPT 구독으로 사용할 수 있나요?</summary><p>이 컴퓨터에서 ChatGPT 계정으로 로그인한 Codex 실행기를 연결하면 생성에 구독 사용량을 쓸 수 있습니다. API 키의 사용료와는 별도입니다. Vercel에서의 구독 로그인은 공식 Sign in with ChatGPT 자격·등록과 별도 연동이 필요하며, 현재 이 사이트에 연결되어 있지 않습니다.</p><a href="https://developers.openai.com/siwc/quickstart" target="_blank" rel="noopener noreferrer">공식 구독 연결 안내 <ArrowUpRight size={12} /></a></details>
  </section>;
}
