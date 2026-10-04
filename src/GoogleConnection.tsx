import type { AuthSession } from './types';
export function GoogleConnection({session}:{session:AuthSession}) {
  return <section aria-label="Google 계정 연결"><div className="google-account-card"><b><span className="google-letter">G</span></b><div><h3>{session.user?session.user.name:'Google 계정으로 시작하기'}</h3><p>{session.user?.email||(session.google?'Google 계정에 프로젝트를 보관합니다.':'Google 로그인 설정을 준비하고 있어요.')}</p></div>{session.google&&!session.user&&<a className="text-button" href="/api/auth/google/start">로그인 →</a>}</div><p className="google-setup-note">{session.google?'로그인한 계정별로 프로젝트와 AI 연결을 관리합니다.':'사이트 운영자가 Google OAuth 클라이언트를 연결하면 로그인할 수 있습니다.'} Google 로그인은 계정 인증이며, Google AI 구독 사용량 연결과는 별도입니다.</p></section>;
}
