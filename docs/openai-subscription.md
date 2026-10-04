# OpenAI API와 로컬 Codex 구독 실행

현재 Launchpad는 OpenAI만 사용한다. 생성 방식은 개인·공용 **OpenAI API 키**, 개인 컴퓨터의 **Codex CLI ChatGPT 로그인**, 키 없는 **로컬 템플릿**으로 구분한다. Google 로그인은 Launchpad의 계정 식별용이며 모델 사용 권한을 부여하지 않는다.

## 로컬 구독 설정

1. 공식 Codex CLI를 설치하고 Launchpad 서버를 실행할 운영체제 계정에서 `codex login`을 실행한다. API 키 로그인이 아닌 ChatGPT 로그인을 선택한다.
2. 같은 실행 환경에서 `codex login status`가 `Logged in using ChatGPT`를 반환하는지 확인한다. 앱·터미널의 권한이나 운영체제 계정이 다르면 로그인 상태가 다를 수 있다.
3. `.env`에 아래 설정을 저장하고 서버를 다시 시작한다. 기본 실행은 `npm run dev`, 빌드 후에는 `npm start`다.

```dotenv
AI_PROVIDER=codex
# PATH에 없을 때만 Codex 실행 파일의 절대 경로를 지정
CODEX_CLI_PATH=
# 비워 두면 CLI의 기본 모델을 사용
CODEX_MODEL=
```

사이트에 연결된 개인 API 키는 서버의 구독 설정보다 우선한다. 구독으로 생성·테스트하려면 개인 키를 해제하고 `/api/config`의 `authMode: "codex-subscription"`, `credentialSource: "subscription"`과 화면 표시를 확인한다. `provider`는 `openai`이며 `codex-default`는 실제 모델 ID를 조회했다는 뜻이 아닌 기본 모델 표시값이다.

공식 Codex는 ChatGPT 구독 로그인과 API 키 로그인을 구분한다. Launchpad는 실행 직전에 CLI의 로그인 상태를 확인하고, API 키 로그인이나 미로그인 상태면 실패로 처리한다. [공식 인증 문서](https://learn.chatgpt.com/docs/auth)

## 실행과 비밀 처리

`server/codex-provider.mjs`는 공식 `codex exec`를 별도 임시 폴더에서 실행한다. 프롬프트는 stdin으로, 출력 형식은 `--output-schema`로 전달하며 JSON 최종 결과를 읽어 기존 Planner·Coding Agent 검증에 연결한다. read-only sandbox와 ephemeral 실행을 사용하고 셸·플러그인 등 작업에 필요 없는 도구를 비활성화한다. 사용자 config는 읽지 않으므로 해당 파일의 모델 설정도 적용되지 않는다. 명시적인 모델 선택은 `CODEX_MODEL`로 한다. [공식 비대화형 실행 문서](https://learn.chatgpt.com/docs/non-interactive-mode)

Launchpad는 Codex 인증 파일이나 토큰 내용을 읽거나 복사하지 않는다. CLI가 자신의 로그인 저장소를 사용한다. 자식 프로세스 환경은 운영체제 경로와 로그인 저장소 경로 등으로 제한하며 `OPENAI_API_KEY`, `CODEX_API_KEY`, Blob·Google·APK 실행기 비밀을 전달하지 않는다. 구독 실패 시 API 키로 자동 전환하지 않는다. 기본 요청 제한 시간은 5분이며 취소 신호는 CLI 프로세스로 전달한다. 임시 응답·스키마 파일은 실행 종료 후 정리한다.

구독 한도와 실제 사용량은 ChatGPT 계정 정책에 따른다. 초기 견적은 단계 수·토큰·시간의 규칙 기반 범위이며 구독 잔액을 조회하거나 API 가격으로 환산하지 않는다. 무료·무제한 사용을 뜻하지 않는다.

## 생성된 결과물의 AI 호출

구독 연결은 **Launchpad에서 프로젝트를 생성하는 과정**에 사용한다. 내려받은 웹 앱, HTTP API, MCP 서버에 Codex 자격 증명이 포함되지 않는다. 로컬 `analyze`·`checklist` 도구는 API 키 없이 동작하지만, 결과물의 `ai` 도구에는 해당 실행 환경의 별도 `OPENAI_API_KEY`가 필요하다. API 토큰과 Google 로그인 세션도 모델 제공자의 키를 대신하지 않는다.

## Vercel과 Sign in with ChatGPT

현재 Vercel 제어 API는 `AI_PROVIDER=openai`만 허용하고 `codex`를 명확한 설정 오류로 거절한다. 로컬 Codex 인증을 Sandbox로 전달하거나 원격 공용 계정처럼 사용하는 경로는 없다. 개인 API 키 또는 명시적으로 설정한 공용 API 키를 사용한다.

Sign in with ChatGPT의 **계정 식별**과 **ChatGPT plan usage 권한**은 별개다. 공식 안내는 현재 적격 Plus·Pro 계정, 오픈소스 프로젝트, 로컬 개인 프로젝트 및 일부 승인된 비공개 앱을 구분한다. 원격·유료 앱은 별도 접근 신청 대상이며 Vercel에 배포했다는 사실만으로 이용 자격이 생기지 않는다. [2026-09-28 공식 구현 안내](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [plan usage 개요](https://developers.openai.com/siwc/token-sharing-open-source)

Launchpad에는 웹사이트용 Sign in with ChatGPT OAuth를 아직 구현하지 않았다. 향후 도입 시 사용자 동의·허용 범위 검증, 계정별 토큰 보관·갱신, 사용 가능한 모델 확인과 스트림 완료 검증을 별도로 구현해야 한다. 이 경로는 일반 API 키 요청과 요구 사항도 다르다. 현재 문서는 `store: false`, `stream: true`를 요구하며 지원되지 않는 필드·도구가 있다. API 키 어댑터의 인증 헤더만 바꾸는 방식으로 대체하지 않는다. [공식 preview 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## 검증 범위

`npm test`는 CLI 실행기를 대체해 로그인 방식, 키 제외, 모델 기본값, JSON 결과, 취소, 임시 파일 정리, 설정·견적을 확인한다. 이 테스트 자체는 모델이나 구독을 호출하지 않는다. 실제 구독 실행 성공과 생성 결과의 기능 검증은 별도의 실행 기록으로 확인한다.
