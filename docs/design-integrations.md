# 디자인 서비스 연결과 실행 견적

확인일: 2026-10-03. 이 문서는 연결 후보와 구현 경계를 정리합니다. 아래 서비스의 계정 연결·유료 생성이 실제로 완료되었다는 뜻은 아닙니다.

## 연결 후보

| 서비스 | Launchpad에서 활용할 부분 | 인증·비용·연결 조건 |
| --- | --- | --- |
| **Stitch** | 설명에서 모바일·웹 화면을 생성하고 HTML·스크린샷·변형안을 받아 시각적 기준으로 사용합니다. 현재 HTML/CSS/JS와 Android WebView 구조에 가장 가까운 후보입니다. | Stitch 전용 API 키 또는 해당 서비스의 OAuth 구성이 필요합니다. Gemini API 키·사이트 Google 로그인과 같은 자격 증명으로 취급하지 않습니다. 확인한 자료에서 안정적인 호출별 단가를 확보하지 못했으므로 예상 금액은 미산정으로 둡니다. Google Labs 공개 SDK에도 공식 지원 제품이 아니라는 안내가 있어 버전 고정과 응답 계약 검증이 필요합니다. [Stitch MCP 설정](https://stitch.withgoogle.com/docs/mcp/setup), [Google Labs SDK 문서](https://github.com/google-labs-code/stitch-sdk/tree/main/packages/sdk) |
| **v0 API** | 자연어에서 UI 코드와 미리보기를 만들고 기존 파일을 넣어 반복 개선할 수 있습니다. 독립적인 React/Next.js 생성 경로를 확장할 때 유용합니다. 현재 신뢰된 세 파일 템플릿에 생성물을 그대로 교체하는 방식은 맞지 않습니다. | 별도 `V0_API_KEY`가 필요합니다. 계정의 플랜·크레딧과 실제 토큰 사용량을 확인해야 하며 Vercel 배포 비용은 분리합니다. [API 개요](https://v0.app/docs/api/v1), [미리보기 포함 빠른 시작](https://v0.app/docs/api/v1/quickstart), [요금 안내](https://v0.app/docs/pricing) |
| **Figma MCP / REST** | 크루의 실제 디자인 파일·컴포넌트·레이아웃 정보를 가져와 같은 스타일로 구현합니다. 새 디자인을 자동으로 생성하는 기능과 기존 디자인을 읽어 구현하는 기능을 구분합니다. | 사용자 OAuth와 파일 권한이 필요합니다. MCP는 승인된 클라이언트 목록을 사용하며 새 클라이언트는 별도 신청이 필요합니다. 플랜·좌석별 호출 한도가 있고 REST 공개 앱에도 게시 요건이 있습니다. [MCP 접근 조건](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/), [도구 기능](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/), [개발자 플랫폼 요건](https://developers.figma.com/docs/updates-to-figmas-developer-platform/) |

현재 구조에서는 **Stitch 시안 → 화면 스타일·레이아웃 추출 → 기존 작동 코드에 적용 → 브라우저 검증 → APK 빌드** 순서가 적합합니다. 외부 디자인 결과는 참고 자료로 다루고 기존 인증·CRUD·오프라인 저장 규칙과 파일 허용 목록을 유지합니다. v0는 다른 프레임워크를 만드는 별도 프로젝트 유형으로 추가하는 편이 명확합니다. 이 선택은 위 서비스 기능과 현재 프로젝트 구조를 비교한 설계 판단입니다.

## Google 구독 로그인과 자동화

Google AI Pro/Ultra 사용자는 공식 Gemini CLI에서 해당 Google 계정으로 로그인할 수 있습니다. 로그인 정보가 로컬에 있는 경우 공식 CLI의 headless 실행과 자동화가 문서화되어 있습니다. 반면 사이트의 Google OIDC 로그인은 신원 인증이며 CLI 구독 권한을 이전하지 않습니다. [CLI 인증](https://geminicli.com/docs/get-started/authentication/), [공식 자동화 방식](https://geminicli.com/docs/cli/tutorials/automation/)

Google 문서는 CLI의 OAuth 자격 증명으로 제삼자 도구가 Code Assist 등 내부 서비스에 직접 접근하는 방식을 약관 위반으로 명시합니다. 따라서 기존 토큰을 복사하거나 비공개 엔드포인트를 호출하는 Vercel 프록시는 연결안으로 삼지 않습니다. 공식 CLI를 사용하는 개인 실행 환경과 웹서비스의 Gemini API 키 실행을 구분합니다. [CLI 약관 안내](https://geminicli.com/docs/resources/tos-privacy/)

구독별 할당량과 API 키 요금은 서로 다르며 수시로 바뀔 수 있습니다. UI의 추정 호출 횟수를 실제 구독 잔액으로 표현하지 않습니다. [CLI 할당량·과금](https://geminicli.com/docs/resources/quota-and-pricing/)

## 사전 견적 모듈

`server/estimate.mjs`는 유료 모델을 호출하지 않는 순수 함수입니다. 입력과 설정이 같으면 같은 결과를 돌려줍니다.

```js
import { estimateProject, estimateOptionsFromEnv } from './server/estimate.mjs';
const estimate = estimateProject(
  { prompt, kind, provider, model },
  estimateOptionsFromEnv(process.env),
);
```

반환 값은 모델 호출 횟수·입출력 토큰·예상 시간의 범위, 계산 가능한 모델 비용, 제외된 비용, 가정입니다. 기본값은 계획·코드 생성 2회와 최대 2회 수정이며 `MAX_RETRIES`는 0~3으로 제한합니다. 시간과 토큰은 **실측 통계가 아닌 규칙 기반 초기 예상치**입니다. 지출 제한·확정 견적·완성 시각이 아닙니다.

모델 단가는 하드코딩하지 않습니다. 운영자가 확인한 현재 단가를 `ESTIMATE_MODEL_RATES_JSON` 환경 변수에 아래 형태로 등록합니다. 아래 숫자는 설정 형식 설명용 예시이며 실제 공급자 요금이 아닙니다.

```json
{
  "gemini/your-model-id": {
    "inputUsdPerMillion": 1,
    "outputUsdPerMillion": 2
  }
}
```

정확한 `공급자/모델` 단가가 없으면 `cost.status`는 `unpriced`, 금액은 `null`입니다. 무료로 표시하지 않습니다. 로컬 템플릿의 모델 비용만 0이며, 구독 CLI 사용량은 API 단가로 환산하지 않습니다. Vercel/Sandbox/Blob·외부 디자인·Android 빌드 서버·구독료·세금 등은 별도입니다. 모바일 예상 시간에는 준비된 빌드 서버의 APK 생성 시간을 더하지만 첫 SDK 설치와 스토어 등록은 제외합니다.

샘플 화면은 실제 샘플이라는 표시와 함께 보여주고, 외부 서비스에서 생성하지 않은 시안을 해당 서비스 결과로 소개하지 않습니다. 실제 연결 후에는 생성 작업의 토큰·시간·빌드 결과를 기록해 이 초기 추정 범위를 보정할 수 있습니다.
