# Launchpad 개발 인계

최종 정리: 2026-10-04. 이 파일은 새 Codex 작업에서 현재 프로젝트를 이어 개발하기 위한 기록이다. 실제 코드를 먼저 확인하고, 사용자의 새로운 요청을 기준으로 작업한다.

## 이어받는 방법

이 파일이 있는 프로젝트 루트 폴더를 Codex 프로젝트로 열고 이 파일과 `README.md`를 읽는다. 다른 컴퓨터에서는 전체 저장소를 clone한 폴더를 연다. 다른 작업이 같은 파일을 수정 중인지 확인한다. 기존 서버가 응답하면 중복 실행하지 않는다.

새 작업에 붙여 넣을 메시지:

> 이 폴더의 CODEX_HANDOFF.md와 README.md를 먼저 읽고 Launchpad 개발을 이어가 줘. 전체 AI Development Agent 플랫폼과 Atelier 모바일 샘플을 구분해서 현재 코드를 확인해 줘. 기존 디자인, 샘플과 사용자 데이터를 보존하고, 구현·검증된 기능과 아직 연결되지 않은 기능을 구분해 줘. 현재 서버 상태를 확인하고 이미 실행 중이면 그대로 사용해 줘. 이어서 할 작업: [원하는 변경사항].

GitHub 저장소는 [hyunaeee/app-automation-gpt](https://github.com/hyunaeee/app-automation-gpt)이며 공개, 기본 브랜치는 `main`이다. 아래 명령으로 소스를 받을 수 있다. 변경사항을 push하려면 저장소 쓰기 권한이 있는 GitHub 계정으로 인증한다.

```sh
git clone https://github.com/hyunaeee/app-automation-gpt.git
cd app-automation-gpt
```

현재 원격 주소와 브랜치는 `git remote -v`, `git status`로 확인한다. 이 대화의 모든 내용이 새 작업에 전달됐다고 가정하지 않고 아래 파일을 실제로 읽는다. `AGENTS.md`에도 다른 Codex가 이어받을 때 필요한 기본 안내가 있다. 인증·실행 설정은 아래의 '실행 및 재검증'과 '다른 컴퓨터로 옮길 때'를 따른다.

## 사용자가 만들고 있는 제품

- 제품명: Launchpad · AI Development Agent.
- 짧은 자연어 아이디어를 요구사항 분석 → 기능 정의 → 구조 설계 → 프로젝트 생성 → 구현 → 테스트 → 오류 수정 → 실행 결과물로 발전시키는 사이트.
- 사용자는 불필요한 상세 설문을 원하지 않는다. 합리적인 기본값으로 진행하되, 한 번에 자동 진행 / 단계별 확인 두 가지 방식을 제공한다.
- 결과물 유형은 웹 앱, Android 모바일 앱, AI 에이전트. 에이전트 제공 형태는 웹사이트 / API / MCP.
- 현재 AI 제공자는 OpenAI로 한정. 개인 API 키 또는 로컬 Codex 구독 실행을 지원한다.
- Google 로그인은 사용자 식별용이다. Google 구독을 OpenAI 모델 사용료에 연결하는 기능이 아니다.
- 최종 호스팅 목표는 Vercel. 비용·예상 시간, 실행 미리보기, 자연어 수정, 샘플 갤러리가 중요하다.
- 디자인을 매우 중요하게 생각한다. 최근 요청은 이미지 모델로 UI 레퍼런스를 먼저 만들고 그 이미지를 기반으로 실제 앱을 제작하는 것.
- 홈 헤드라인은 사용자가 지정한 `Build what you have in mind.` 한 줄을 유지한다.

## 현재 구현

- React / TypeScript / Vite 프런트엔드, Node.js / Express 제어 서버.
- Planner / Coding / Validation / Debugging 워크플로, 생성 파일·계획·진행 로그·검증 결과.
- 자동 모드 및 기획·기능·설계 확인 후 진행하는 guided 모드.
- 개인 OpenAI 키의 서버 암호화 저장, 로컬 공식 Codex CLI의 ChatGPT 로그인으로 구독 실행.
- 작업 역할에 맞는 모델 선택, 필요한 이미지 생성, 실제 모델 사용·건너뜀·실패 기록.
- 모바일 오프라인 WebView 미리보기, Android SDK 기반 실제 debug APK 컴파일·서명·다운로드.
- 버전별 수정과 소스 다운로드. 원본을 보존하는 구조.
- Vercel Blob / Sandbox 어댑터, Google OAuth 코드, 원격 APK 빌드 서비스 코드.

## 실제 구현과 구분할 것

- Atelier 모바일 샘플은 이 Codex 작업에서 **내장 image_gen으로 UI 레퍼런스 생성 → 이미지 확인 → 구현 → 브라우저 검증 → 실제 APK 검증** 순서로 제작한 결과다.
- 모든 새 프로젝트에 UI 레퍼런스 이미지를 먼저 만들고 Coding Agent에 시각 입력으로 전달하는 범용 자동 파이프라인이 이미 완성된 것은 아니다. `server/app.mjs`, `server/visual-assets.mjs`, `server/provider.mjs`의 실제 순서를 확인해야 한다.
- 앱의 OpenAI API 이미지 경로와 이 작업에서 사용한 Codex 내장 image_gen은 서로 다른 실행 경로다. 현재 로컬 Codex CLI 공급자에 내장 image_gen 사용 권한이 자동 연결돼 있다고 가정하지 않는다.
- Vercel 운영 배포와 실제 외부 자격 증명 통합 검증은 별도다. 이 컴퓨터의 Codex 구독 로그인이 Vercel로 이동하지 않는다.
- 스토어 자동 제출, 운영용 릴리스 서명, iOS 빌드는 완료되지 않았다.
- 자유로운 프로젝트의 임의 서버 코드를 무제한 실행하는 시스템이 아니다. 신뢰된 서버 템플릿과 허용된 생성 파일을 결합한다.

## 최신 모바일 샘플

- 이름: Atelier · 모바일 디자인 스튜디오.
- 프로젝트 ID: `40a5f71e-6bb8-4b23-8cb3-1459487b9882`.
- 로컬 프로젝트 화면: `http://127.0.0.1:3001/#project/40a5f71e-6bb8-4b23-8cb3-1459487b9882`.
- 원본 코드: `samples/atelier-mobile/app/`.
- UI 레퍼런스: `samples/atelier-mobile/design/reference-v1.png`.
- 이미지 프롬프트: 같은 폴더의 `image-prompt.json`, `tote-image-prompt.json`.
- 레퍼런스에 맞춰 별도 생성한 제품 사진: `tote-photo-v1.png` / 최적화 JPEG. 실행 앱은 `public/design-assets.js`에 이미지를 포함한다.
- APK: `samples/atelier-mobile/atelier-mobile.apk` (414,375 bytes).
- 소스 ZIP: `samples/atelier-mobile/source.zip`. **이 ZIP은 Atelier 앱 + Android 소스 + 디자인 자료이며 Launchpad 전체 플랫폼 소스가 아니다.**
- 결과 보고서: `samples/atelier-mobile/report.html`, `run-report.json`.
- 검증 증거: `browser-report.json`, `apk-build-report.json`, `delivery-report.json`, `gallery-report.json`, `screenshots/`.
- 공개 갤러리 데이터: `public/examples/atelier-mobile/`.
- 기기 안에서 치수·도면·재료·비용 계산, 초안 저장·불러오기·수정·삭제, 제작 문의 내용 정리가 작동한다.
- 사진은 정적 콘셉트다. 치수는 직접 입력하며 생산용 봉제 패턴·실측·실제 업체 견적이 아니다. 자연어 초안은 제한된 로컬 규칙이며 앱 안의 실시간 AI 호출이 아니다.
- 검증: 브라우저 19개, Android 36 설치·실행·이미지·견적·저장·재실행 유지 등 10개, 갤러리 E2E 3개, 전달 경로 6개, Node 런타임 6개 통과. `npm run build` 통과.
- 테스트용 3003·62010 서버와 headless 에뮬레이터는 정리했다. 3001 메인 서버 상태는 이어받을 때 확인한다. 동적 미리보기 포트는 서버 재시작 후 달라질 수 있다.

기존 웹 샘플은 `samples/fashion-design/`, 갤러리는 `public/examples/atelier/`, 프로젝트 ID는 `d40108eb-be56-48c3-b22a-7e2a86a09953`이다.

## 먼저 볼 코드와 문서

| 영역 | 파일 |
| --- | --- |
| 워크플로·로컬 API | `server/app.mjs`, `server/workflow-review.mjs` |
| 모델 공급자 | `server/provider.mjs`, `server/codex-provider.mjs`, `server/model-router.mjs`, `server/image-provider.mjs` |
| 생성 이미지 연결 | `server/visual-assets.mjs` |
| Android | `server/android-builder.mjs`, `server/mobile-builds.mjs`, `server/android-template/MainActivity.java` |
| 홈과 샘플 갤러리 | `src/StudioHome.tsx`, `src/AtelierCaseStudy.tsx`, `src/AtelierMobileCaseStudy.tsx` |
| 프로젝트·모바일 미리보기 | `src/ProjectDetail.tsx`, `src/MobilePreview.tsx` |
| 배포·연결 설명 | `docs/vercel.md`, `docs/openai-subscription.md`, `docs/android-build.md`, `docs/model-routing.md` |

## 실행 및 재검증

Node.js 22 이상. 이미 설치돼 있는 같은 PC에서는 의존성을 다시 설치할 필요가 없다. 다른 컴퓨터의 새 소스 사본에서는 다음을 실행한다.

```sh
npm ci
npm run build
npm start
```

사이트는 `http://127.0.0.1:3001`. 개발용 HMR은 `npm run dev`. Windows PowerShell에서 실행 정책에 막히면 `npm.cmd`를 사용한다.

구독 테스트 설정은 `.env.example`을 참고해 `.env`에 `AI_PROVIDER=codex`를 설정한다. 새 컴퓨터에는 공식 Codex CLI를 설치하고 `codex login` 및 `codex login status`로 ChatGPT 로그인을 확인한다. 기존 `.env`를 임의로 덮어쓰지 않는다. 사이트에 연결된 개인 API 키가 있다면 그 연결이 구독 설정보다 우선할 수 있다.

APK 재빌드에는 JDK 17+, Android SDK Platform 34 및 Build Tools 34+가 필요하다. `JAVA_HOME` / `ANDROID_HOME`을 확인하고 `docs/android-build.md`를 따른다. 이미 만들어진 APK를 다운로드하는 데 SDK는 필요 없다.

관련 검증 명령:

```sh
npm run build
node scripts/build-atelier-mobile.mjs --check
node scripts/build-atelier-mobile.mjs
node scripts/verify-atelier-mobile.mjs
```

브라우저 검증 스크립트의 URL 환경 변수와 Android 검증 스크립트의 대상 기기 설정을 먼저 읽는다. 검증 보고서의 소스 해시가 바뀌면 이전 APK를 새 코드의 검증 결과로 취급하지 않는다.

샘플 공개·저장 스크립트는 `scripts/publish-atelier-mobile.mjs`와 `scripts/finalize-atelier-mobile-report.mjs`. `--install`은 **현재 서버를 종료한 뒤에만** `.data/projects.json`과 프로젝트 파일을 갱신한다. 기존 프로젝트 실행·빌드가 진행 중일 때 사용하지 않는다. 소스·검증 보고서·APK가 일치해야 한다.

## 다른 컴퓨터로 옮길 때

- 전체 플랫폼 개발에는 프로젝트 루트의 소스·설정·`package-lock.json`·`docs/`·`samples/`·`public/`가 필요하다. `node_modules/`, `dist/`, 테스트 캐시는 새 환경에서 재생성한다.
- `.data/`에는 내 프로젝트 목록·파일뿐 아니라 암호화된 키, 로컬 비밀, 개발 서명 키 등도 있다. `.env`와 함께 공개 저장소나 일반 공유 ZIP에 포함하지 않는다. 기존 기록이 필요하면 필요한 상태만 본인 간 비공개 백업·이전으로 다룬다.
- `.data/`를 제외하면 공개 샘플 갤러리와 소스는 남지만 기존 ‘내 프로젝트’ 목록은 자동 복원되지 않는다.
- API 키, Google OAuth, Codex 로그인, JDK/SDK 경로는 새 환경에서 설정한다. 인증 파일을 채팅에 붙여 넣지 않는다.
- 프로젝트 파일을 옮겨도 예전 `localhost` 주소의 프로세스가 새 컴퓨터에서 실행되는 것은 아니다. 새 환경에서 서버를 실행한다.

## 확인한 공식 자료

- [Codex를 선택하고 프로젝트 폴더 열기](https://learn.chatgpt.com/docs/quickstart)
- [Codex CLI의 ChatGPT 로그인과 상태 확인](https://learn.chatgpt.com/docs/auth)
