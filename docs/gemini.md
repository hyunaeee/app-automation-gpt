# Gemini API 연결

Google 로그인은 Launchpad 계정 신원을 확인합니다. Gemini 모델 호출은 **Google AI Studio에서 발급한 Gemini API 키**를 별도로 사용합니다. 이 어댑터는 Google AI Pro/Ultra 구독 사용량을 소비하는 연결이 아니며, 해당 API 프로젝트의 사용 한도와 과금 설정이 적용됩니다.

기본 모델은 `gemini-3.8-flash`입니다. 2026년 10월 3일 확인한 공식 문서에서는 새로운 프로젝트에 최신 모델을 권장하며, `gemini-2.5-flash`는 과거에 해당 모델을 이용한 사용자로 접근을 제한한다고 안내합니다. 모델 입력란에서 계정이 지원하는 텍스트·구조화 출력 모델로 변경할 수 있습니다.

어댑터는 서버에서 `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`를 호출합니다. API 키는 `x-goog-api-key` 헤더에만 넣고 URL, 모델 입력, 생성한 파일에는 넣지 않습니다. `generationConfig.responseFormat.text`에 JSON MIME 유형과 JSON Schema를 지정하고, 반환된 계획과 브라우저 파일은 기존 플랫폼 검증기를 거칩니다. 안전 정책 차단, 토큰 한도, 완료되지 않은 응답, 예상하지 않은 도구 호출은 오류로 처리합니다.

웹 앱과 AI 에이전트는 기존 서버의 인증·CRUD API를 사용합니다. 모바일 앱의 생성 코드는 상대경로 HTML/CSS/JavaScript와 기기 localStorage만 사용하도록 제약하며, 클라우드 로그인이나 서버 API를 포함하지 않습니다. 실제 Android 패키징과 실행 검증은 별도 워크플로 단계에서 처리합니다.

테스트는 모의 API 응답으로 수행합니다. 실제 API 키를 사용한 생성 결과와 사용량은 아직 검증하지 않았습니다.

공식 문서: [구조화 출력 REST](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Gemini 2.5 Flash 접근 조건](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash), [Gemini API 과금](https://ai.google.dev/gemini-api/docs/billing).
