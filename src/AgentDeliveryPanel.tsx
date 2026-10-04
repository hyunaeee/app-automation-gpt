import { Cable, Globe, KeyRound } from 'lucide-react';
import type { Project } from './types';

export default function AgentDeliveryPanel({project,previewUrl}:{project:Project;previewUrl:string|null}) {
  const delivery=project.agentDelivery||'web';
  const setup=project.files.find(file=>file.path==='mcp.config.json')?.content;
  return <section className="agent-delivery-panel" aria-label="에이전트 연결 안내">
    <div className="agent-delivery-title">{delivery==='mcp'?<Cable size={19}/>:delivery==='api'?<KeyRound size={19}/>:<Globe size={19}/>}<div><b>{delivery==='mcp'?'AI 도구에 연결하는 MCP':delivery==='api'?'다른 서비스에서 호출하는 API':'주소로 사용하는 에이전트'}</b><p>{delivery==='mcp'?'소스를 내려받아 로컬 MCP 서버로 실행하세요.':delivery==='api'?'앱에 가입한 뒤 API 콘솔에서 호출용 토큰을 발급하세요.':'웹 화면에서 도구를 실행하고 결과를 보관할 수 있어요.'}</p></div></div>
    {delivery==='mcp'&&<><pre><code>npm install{'\n'}npm run mcp</code></pre><details><summary>MCP 연결 설정 예시</summary><pre><code>{setup||'소스의 mcp.config.json을 확인하세요.'}</code></pre><p>설정의 경로를 내려받은 폴더의 절대 경로로 바꿔주세요. 로컬 stdio 연결을 지원하는 클라이언트용이며, 원격 MCP 주소 배포는 포함되지 않습니다.</p></details></>}
    {delivery==='api'&&<><pre><code>POST /v1/agent/run{'\n'}Authorization: Bearer &lt;앱에서 발급한 토큰&gt;{'\n'}{'{"input":"정리할 내용","tool":"checklist"}'}</code></pre><p>OpenAI 키와 별개인 앱 호출용 토큰을 사용합니다. OpenAPI 명세는 소스의 openapi.json에 포함돼요.</p>{previewUrl&&<a href={new URL('/console'+new URL(previewUrl).search,previewUrl).toString()} target="_blank" rel="noopener noreferrer" className="secondary-button">API 콘솔 열기 ↗</a>}</>}
    {delivery!=='web'&&<p className="agent-delivery-limit">기본 분석·체크리스트는 키 없이 실행됩니다. 결과물의 AI 도구는 실행 서버에 별도 OpenAI API 키가 필요합니다.</p>}
  </section>;
}
