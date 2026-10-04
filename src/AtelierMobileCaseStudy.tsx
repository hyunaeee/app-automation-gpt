import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BatteryFull, Check, Code2, Image, RotateCcw, Signal, Smartphone, Wifi } from 'lucide-react';
import { previewDocument } from './AtelierCaseStudy';
import type { GeneratedFile } from './types';
import './atelier-mobile-case.css';

type MobileSample = { name: string; prompt: string; files: GeneratedFile[]; verified: boolean; referenceImage: string };
type PreviewTab = 'app' | 'reference';
const base = '/examples/atelier-mobile';
const frameWidth = 414;
const frameHeight = 910;

export default function AtelierMobileCaseStudy({ onUse }: { onUse: (prompt: string) => void }) {
  const [sample, setSample] = useState<MobileSample | null>(null);
  const [tab, setTab] = useState<PreviewTab>('app');
  const [revision, setRevision] = useState(0);
  const [scale, setScale] = useState(.74);
  const stage = useRef<HTMLDivElement>(null);
  const appTab = useRef<HTMLButtonElement>(null);
  const referenceTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${base}/sample.json`, { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(value => {
      const validFiles = Array.isArray(value?.files) && value.files.every((file: GeneratedFile) => typeof file?.path === 'string' && typeof file.content === 'string') && ['public/index.html', 'public/styles.css', 'public/app.js'].every(path => value.files.some((file: GeneratedFile) => file.path === path));
      if (!controller.signal.aborted && value?.verified === true && typeof value.name === 'string' && typeof value.prompt === 'string' && validFiles) setSample(value);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!sample || !stage.current) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setScale(Math.max(.35, Math.min(.78, (width - 40) / frameWidth)));
    });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [sample]);
  const source = useMemo(() => sample ? previewDocument(sample.files) : '', [sample]);
  const selectTab = (next: PreviewTab, focus = false) => {
    setTab(next);
    if (focus) (next === 'app' ? appTab : referenceTab).current?.focus();
  };
  if (!sample) return null;

  return <section id="atelier-mobile" className="atelier-mobile-case" aria-label="디자인에서 APK까지 모바일 앱 검증 샘플">
    <div className="amc-heading"><div><span className="section-kicker">A DESIGN, MADE REAL.</span><h2>먼저 그려보고. <span>바로 사용해보고.</span></h2><p>디자인 이미지에서 실제 모바일 앱, 설치 파일까지 이어진 또 하나의 결과물.</p></div><span className="amc-verified"><Check size={13} />ANDROID SAMPLE</span></div>
    <div className="amc-body">
      <div className="amc-story">
        <div className="amc-edition"><span>ATELIER</span><span>MOBILE EDITION / 02</span></div>
        <h3>A little studio.<br /><em>In your pocket.</em></h3>
        <p className="amc-intro">아이디어를 눈으로 먼저 확인하고,<br />손으로 직접 다뤄볼 수 있도록.</p>
        <p className="amc-origin">이번 Codex 작업에서 디자인 이미지를 먼저 만들고 구현·검증한 샘플입니다.</p>
        <ol className="amc-process">
          <li><span>01</span><div><b>디자인 이미지</b><p>스튜디오·디자인·견적 화면의 분위기와 구성을 먼저 그렸어요.</p></div><Image size={16} /></li>
          <li><span>02</span><div><b>실제로 작동하는 앱</b><p>치수 편집, 개념도, 재료량·비용 계산과 저장을 화면에 연결했어요.</p></div><Smartphone size={16} /></li>
          <li><span>03</span><div><b>내 휴대폰에 설치</b><p>같은 앱을 오프라인에서 실행하는 Android APK로 패키징했어요.</p></div><ArrowDownToLine size={16} /></li>
        </ol>
        <div className="amc-brief"><span>THE ORIGINAL IDEA</span><p>“{sample.prompt}”</p></div>
        <a className="amc-apk-download" href={`${base}/atelier-mobile.apk`} download><ArrowDownToLine size={16} /><span>Android APK 받기<small>개발용 서명 · 직접 설치 샘플</small></span><ArrowUpRight size={18} /></a>
        <div className="amc-downloads"><a href={`${base}/source.zip`} download><Code2 size={13} />앱 소스</a><a href={`${base}/reference-v1.png`} download><Image size={13} />디자인 이미지</a><a href={`${base}/image-prompt.json`} download>디자인 프롬프트<ArrowDownToLine size={12} /></a></div>
        <button className="amc-use" onClick={() => onUse(sample.prompt)}>이 아이디어로 모바일 앱 만들기<ArrowRight size={15} /></button>
        <p className="amc-scope">사진은 미리 생성한 정적 콘셉트입니다. 치수와 비용은 입력값·가정 단가로 계산하며 실제 실측이나 제작 견적을 대신하지 않아요. APK는 테스트 설치용이며 스토어 출시 버전이 아닙니다.</p>
      </div>
      <div className="amc-showcase">
        <div className="amc-tabs" role="tablist" aria-label="모바일 샘플 비교" onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); selectTab(event.key === 'Home' ? 'app' : event.key === 'End' ? 'reference' : tab === 'app' ? 'reference' : 'app', true); }
        }}>
          <button ref={appTab} id="atelier-mobile-app-tab" role="tab" aria-selected={tab === 'app'} aria-controls="atelier-mobile-app-panel" tabIndex={tab === 'app' ? 0 : -1} onClick={() => selectTab('app')}><Smartphone size={14} />작동하는 앱<span className="amc-live-dot" /></button>
          <button ref={referenceTab} id="atelier-mobile-reference-tab" role="tab" aria-selected={tab === 'reference'} aria-controls="atelier-mobile-reference-panel" tabIndex={tab === 'reference' ? 0 : -1} onClick={() => selectTab('reference')}><Image size={14} />디자인 레퍼런스</button>
        </div>
        <div className="amc-stage" ref={stage}>
          <div id="atelier-mobile-app-panel" role="tabpanel" aria-labelledby="atelier-mobile-app-tab" hidden={tab !== 'app'} className="amc-app-panel">
            <div className="amc-device-caption"><span><i />LIVE / TOUCH & EXPLORE</span><button aria-label="모바일 패션 샘플 초기화" onClick={() => setRevision(value => value + 1)}><RotateCcw size={13} />초기화</button></div>
            <div className="amc-phone-space" style={{ width: frameWidth * scale, height: frameHeight * scale }}>
              <div className="amc-phone" style={{ transform: `scale(${scale})` }}>
                <div className="amc-phone-status" aria-hidden="true"><b>9:41</b><span><Signal size={13} /><Wifi size={13} /><BatteryFull size={17} /></span></div>
                <iframe key={revision} title="Atelier 모바일 앱 검증 샘플" srcDoc={source} sandbox="allow-scripts allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" loading="lazy" />
                <div className="amc-phone-home" aria-hidden="true"><i /></div>
              </div>
            </div>
            <p className="amc-preview-caption">화면을 눌러 디자인하고, 안쪽으로 스크롤해 보세요.</p>
          </div>
          <div id="atelier-mobile-reference-panel" role="tabpanel" aria-labelledby="atelier-mobile-reference-tab" hidden={tab !== 'reference'} className="amc-reference-panel">
            <span className="amc-reference-label">01 / THE DESIGN REFERENCE</span>
            <a href={`${base}/reference-v1.png`} target="_blank" rel="noopener noreferrer" aria-label="모바일 디자인 레퍼런스 원본 보기"><img src={`${base}/reference-v1.png`} alt="Atelier 스튜디오, 가방 디자인, 제작비 견적을 보여주는 세 화면의 모바일 디자인 레퍼런스" loading="lazy" /></a>
            <div className="amc-reference-caption"><b>한 장으로 정리한, 앱의 첫인상.</b><p>아이보리 바탕, 차분한 올리브와 테라코타 컬러.<br />이 이미지의 방향을 실제 앱 화면과 인터랙션으로 옮겼어요.</p><a href={`${base}/reference-v1.png`} target="_blank" rel="noopener noreferrer">원본 이미지 보기<ArrowUpRight size={13} /></a></div>
          </div>
        </div>
        <p className="amc-preview-note">390 × 844 웹 화면의 기기 미리보기입니다. Android OS 에뮬레이터가 아니며, 체험 기록은 초기화하거나 페이지를 다시 열면 사라집니다.</p>
      </div>
    </div>
  </section>;
}
