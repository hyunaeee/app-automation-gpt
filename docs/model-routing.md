# 작업별 모델과 이미지 생성

OpenAI API 연결에서는 생성 시 `GET /v1/models`로 계정에 노출된 모델을 확인합니다. 이 응답은 기능 표가 아니므로 코드에서 검토한 Responses·구조화 출력 모델 및 이미지 모델 목록과 교차 확인합니다. 목록 조회는 모델 생성 요청을 실행하지 않습니다. 계정 권한·조직 검증·잔액·사용 한도는 실제 요청에서 거절될 수 있습니다. [모델 목록 API](https://developers.openai.com/api/reference/resources/models/methods/list)

기본 설정인 `gpt-4.1-mini`는 사용 가능한 목록 안에서 기획에 GPT-6 Luna, 구현·수정에 GPT-6.1 Sol을 우선 선택하는 자동 모드의 대체 모델입니다. 오류 수정에는 지원 모델의 추론 수준을 높입니다. 후보가 없으면 계정에 있는 검토된 다른 텍스트 모델을 선택하고, Astra를 비용 확인 없이 자동 선택하지 않습니다. 다른 기본 모델을 직접 설정했다면 그 모델을 유지합니다. `OPENAI_PLANNER_MODEL`, `OPENAI_CODER_MODEL`, `OPENAI_DEBUGGER_MODEL`, `OPENAI_IMAGE_MODEL`은 역할별 명시적 설정이며 기본값보다 우선합니다. [공식 모델 목록](https://developers.openai.com/api/docs/models), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

모델 목록은 연결 객체별로 5분간 캐시합니다. 조회의 인증·권한 오류는 실패로 처리하며 다른 모델이나 다른 키로 우회하지 않습니다. 네트워크·서비스 오류로 목록을 확인하지 못한 경우에는 설정한 텍스트 모델만 사용하고 이미지는 비활성화합니다. 명시한 텍스트 모델이 목록에 없으면 실패하며, 잘못되거나 사용할 수 없는 이미지 모델 설정은 이미지 생성만 비활성화합니다.

이미지가 필요한 작업은 확인된 GPT Image 2.5 Flare, Sunburst 또는 GPT Image 2 모델로 이미지 한 장을 생성합니다. 현재 연결은 Image API에 1024×1024, 중간 품질, JPEG 압축 80을 요청하고 최대 2MB의 PNG/JPEG만 받습니다. 외부 이미지 URL·SVG·임의 실행 파일을 결과로 받지 않습니다. 이미지는 정적인 시각 자료이며 치수를 바꾸면 자동 재생성되는 제품 설계 결과나 실제 촬영 사진을 의미하지 않습니다. [이미지 생성 가이드](https://developers.openai.com/api/docs/guides/image-generation), [Images API 필드](https://developers.openai.com/api/reference/resources/images/methods/generate)

기획·구현·수정·이미지 호출은 사용한 모델과 완료·실패·건너뜀 상태를 기록합니다. 응답이 실제 모델 ID를 제공하면 그것을 기록하고, 그렇지 않으면 요청한 모델을 기록합니다. 이미지 요금은 텍스트 토큰 견적과 별도이며 모델별 단가가 없으면 비용을 미산정으로 표시합니다.

로컬 Codex 구독은 공식 CLI의 명시 모델 또는 CLI 기본 모델을 유지합니다. 지원 모델에서는 기획·구현에 `medium`, 오류 수정에 `high` 추론을 요청하며 알 수 없는 사용자 모델에는 추론 값을 강제하지 않습니다. CLI 기본 모델 ID를 확인하지 못한 경우 사용 내역의 모델은 `null`이고 설명에 CLI 기본 모델로 표시합니다. API 모델 목록이나 이미지 생성 권한이 있다고 간주하지 않으며 별도의 API 키 없이 이미지 API를 호출하지 않습니다. [Codex 실행 설정](https://learn.chatgpt.com/docs/developer-settings), [추론 설정](https://learn.chatgpt.com/docs/config-file/config-reference)
