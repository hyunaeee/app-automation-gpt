# 앱스토어 배포 자동화 확장 설계

확인일: **2026-10-03**. 아래는 공식 문서를 확인한 확장 설계이며 아직 구현·등록·업로드·심사 제출한 기능이 아닙니다. 현재 구현은 Android **개발용 APK 생성과 직접 다운로드**까지입니다. 스토어 업로드 자동화, 심사 접수, 심사 통과, 사용자에게 공개되는 시점은 각각 다른 상태로 표시해야 합니다.

## 플랫폼별 준비 사항

| 항목 | Google Play | Apple App Store |
| --- | --- | --- |
| 개발자 등록 | 일회성 **US$25**, 계정 유형별 신원 확인, 새 개인 계정은 실제 Android 기기 확인 | **US$99/년**, 신원 확인 및 약관 동의, 조직은 법인·권한·D-U-N-S 등 확인 |
| 배포 산출물 | 새 앱은 릴리스 서명 **AAB**, Play App Signing 및 업로드 키 | 별도 iOS 프로젝트의 서명된 빌드, Bundle ID·배포 인증서·프로비저닝 |
| 실행기 | JDK·Android SDK·Gradle을 갖춘 격리 빌드 서버 | macOS/Xcode 빌드 실행기 또는 Xcode Cloud |
| 연결 권한 | Play Developer API 활성화, 앱 권한을 부여한 서비스 계정 또는 사용자 OAuth | App Store Connect의 해당 역할 및 API 키/JWT |
| 자동화 범위 | 기존 앱의 번들·스토어 정보·스크린샷 업로드, 트랙·출시 변경 | 빌드 업로드, 메타데이터·TestFlight·심사 제출·승인 후 출시 관리 |

등록비와 계정 확인: [Play 등록](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en), [Apple 등록](https://developer.apple.com/programs/enroll/). 지역별 통화·세금·면제 자격은 결제 시 확인합니다. Google 계정 로그인이나 Google AI 구독만으로 개발자 등록·스토어 권한·등록비가 해결되지는 않습니다.

Android의 현재 샘플은 target SDK 34와 개발용 서명을 사용합니다. 일반 휴대폰 앱의 신규 제출·업데이트는 **2026-08-31부터 API 36 이상**이 요구되므로 출시용 실행기는 SDK·Gradle 템플릿을 올리고 새 동작을 검증해야 합니다. 단순히 파일 확장자를 APK에서 AAB로 바꾸면 안 됩니다. [대상 API 요건](https://developer.android.com/google/play/requirements/target-sdk), [AAB 게시 형식](https://developer.android.com/studio/publish), [앱 서명](https://developer.android.com/studio/publish/app-signing)

iOS는 Android APK를 변환해서 만들 수 없습니다. Swift/WKWebView 또는 별도의 크로스플랫폼 iOS 타깃을 만들고 macOS에서 아카이브·서명해야 합니다. 업로드 시점의 Xcode/SDK 요구 버전을 확인합니다. Apple은 API를 통한 바이너리 업로드도 문서화하고 있으므로 자동화가 반드시 수동 Transporter 업로드에 의존하지는 않습니다. [빌드 업로드](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds), [App Store Connect API](https://developer.apple.com/app-store-connect/api/)

## 계정 소유자가 해야 하는 최초 단계

개발자 등록, 본인·조직 확인, 약관 수락, 등록비 결제와 스토어 권한 부여는 계정 소유자가 진행합니다. Play의 Edits API는 기존 앱 변경을 대상으로 하며 최초 앱 등록·첫 아티팩트 등록 및 법적 동의까지 전부 대체하지 않습니다. 각 앱의 개인정보 처리, 등급, 광고·결제 여부, 연락처 등의 사실관계도 소유자가 확인해야 합니다. 실제 기능에서 증거를 수집해 초안을 만드는 것은 자동화할 수 있지만 에이전트가 사실을 추측해 신고해서는 안 됩니다. [Play API 시작](https://developers.google.com/android-publisher/getting_started), [Edits API 범위](https://developers.google.com/android-publisher/edits)

**2023-11-13 이후 만든 Play 개인 계정**은 최소 12명의 테스터가 14일 연속 참여한 비공개 테스트를 거쳐 프로덕션 접근을 신청해야 합니다. 조건 충족 후에도 접근 심사가 있으며 공식 안내는 보통 7일 이내지만 더 걸릴 수 있다고 설명합니다. 이 기간은 생성 속도를 높여도 생략할 수 없습니다. [개인 계정 테스트 요건](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)

Apple은 평균 90%의 제출물이 24시간 이내 검토된다고 안내하지만 개별 앱의 승인 기한이나 출시 보장이 아닙니다. 계정 등록, 빌드 처리, 보완 요청 및 재심사 시간도 별도입니다. [App Review](https://developer.apple.com/distribute/app-review/)

## 기존 Launchpad에 붙이는 구조

아래 구조는 제안이며 현재 구현된 기능 목록이 아닙니다.

1. **Release Planner**: 프로젝트의 앱 식별자·소유 개발자 계정·버전·플랫폼·테스트 트랙을 고정합니다. 같은 앱의 업데이트는 식별자와 서명 계보를 유지합니다.
2. **Store Package Builder**: Android 실행기는 `bundleRelease`로 AAB를 만들고 업로드 키로 서명합니다. iOS 실행기는 별도 macOS 작업으로 아카이브·서명합니다. 현재 APK 직접 다운로드는 개발용 경로로 유지합니다.
3. **Store Asset Agent**: 실제 실행 화면에서 규격별 스크린샷·아이콘·설명·릴리스 노트를 준비합니다. 구현되지 않은 기능을 스토어 설명에 추가하지 않습니다.
4. **Release Validator**: 실제 기기/에뮬레이터 실행, 접근성·회전·복구·데이터 유지, 개인정보 및 심사 메타데이터 누락을 확인합니다. 검증 결과와 정확한 빌드 해시를 연결합니다.
5. **Publisher Adapter**: Play는 edit 생성 → `edits.bundles.upload` → listing/image/tracks 갱신 → 검증·commit 순서로 처리합니다. Apple은 빌드 처리 완료를 확인한 후 버전·스크린샷·TestFlight/심사 제출을 연결합니다. 계정별 권한 범위 안에서 수행합니다. [AAB 업로드 API](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload)
6. **Release Tracker**: `준비 중 → 빌드됨 → 테스트 배포됨 → 심사 대기 → 심사 중 → 보완 필요/승인 → 공개됨`을 별개로 저장합니다. API 성공을 “스토어 출시 완료”로 표시하지 않습니다. 중복 제출 방지 키와 재시도 가능한 작업 기록을 남깁니다.

Vercel은 UI·인증·작업 요청·상태 조회를 맡고, Android/iOS 빌드와 서명은 별도 실행기에서 처리합니다. 장기 작업은 내구성 있는 큐로 전달하고 APK/AAB/IPA는 소유권 검사 후 다운로드합니다. 스토어용 권한·서명 키는 일반 AI API 키와 분리하여 서버 비밀 저장소에 보관하며 생성 코드·ZIP·로그·브라우저 저장소에 넣지 않습니다. 사용자별 개발자 계정과 프로젝트를 연결하고 다른 사용자의 계정으로 업로드하지 않습니다.

## 현재 WebView MVP의 출시 한계

현재 앱은 오프라인 기록 생성·수정·완료·저장을 실제 제공하지만 이것만으로 스토어 승인 준비가 끝났다고 볼 수 없습니다. 앱마다 고유한 문제를 해결하는 기능·콘텐츠와 완성된 아이콘·지원/개인정보 안내·기기 검증이 필요합니다. 이는 현재 코드와 아래 정책을 대조한 판단입니다.

Google은 기능이 없거나 매우 제한적이거나 제대로 작동하지 않는 앱을 허용하지 않습니다. **WebView 사용 자체를 곧바로 금지한다는 의미는 아닙니다.** Apple 4.2는 단순 웹사이트 포장을 넘어서는 유용성·고유성을 요구하며, 4.2.6은 상용 템플릿/앱 생성 서비스 결과물을 앱 콘텐츠 제공자가 직접 제출하도록 규정합니다. 따라서 모든 사용자 앱을 Launchpad 공용 개발자 계정으로 대량 게시하는 방식으로 설계하지 않습니다. [Google 기능 품질](https://support.google.com/googleplay/android-developer/answer/9898783?hl=en), [Apple 4.2·4.2.6·4.3](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality)

생성한 iOS 앱에 Google 등 소셜 로그인을 넣는 경우에는 Apple 4.8의 동등한 개인정보 보호 로그인 요건과 예외를 확인해야 합니다. Launchpad 웹사이트의 Google 로그인과 생성 앱의 로그인은 별도 기능입니다. [Apple 로그인 서비스 기준](https://developer.apple.com/app-store/review/guidelines/#login-services)

## 비용·시간 표시 제안

앱 생성 전에는 **예상 범위와 근거**, 작업 후에는 **실측 사용량**을 구분합니다. 견적은 `개발자 등록비 + AI 토큰/이미지 비용 + 빌드 실행 시간 × 실행기 단가 + 저장/전송 + 호스팅/디자인 좌석`으로 나눕니다. 스토어 판매 수수료·세금·외부 API 운영비는 이 생성 견적과 분리합니다. 모델·실행기·구독의 최신 단가와 포함량이 없으면 임의의 확정 금액을 표시하지 않습니다.

- **필수 등록비 기준**: Play만 배포하면 US$25 일회성, 두 스토어 신규 등록 첫해는 US$124가 기준입니다. AI·호스팅·빌드·지역 세금은 별도입니다.
- **호스팅**: Vercel Pro는 현재 월 US$20 기본 요금에 사용량 등이 더해지는 구조입니다. Android 빌드 서버 비용까지 포함한 가격이 아닙니다. [Vercel 가격](https://vercel.com/pricing)
- **iOS 빌드**: Apple Developer Program에는 Xcode Cloud 월 25 컴퓨트 시간이 포함됩니다. 초기 구성과 실제 워크플로 필요 시간을 확인하고 초과 비용을 따로 계산합니다. [Xcode Cloud](https://developer.apple.com/xcode-cloud/)
- **디자인**: 초기에는 기존 갤러리 분석, CSS 디자인 토큰, 실제 화면 스크린샷과 Figma Starter로 시작할 수 있습니다. 유료 Figma 좌석·이미지 생성은 선택 비용으로 분리합니다. [Figma 플랜](https://www.figma.com/pricing/)
- **빌드 시간**: 이번 로컬 SDK 스모크 테스트는 준비된 도구에서 약 2.5초였지만 다운로드·콜드 스타트·AI 코드 생성·기기 테스트·출시 심사를 포함하지 않습니다. 제품에서는 최근 같은 유형 작업의 중앙값과 상위 지연 구간을 보여주는 편이 적절합니다.

한 명의 숙련 개발자가 기존 구조에서 추가 구현한다는 가정의 **초기 작업량 추정**은 Android AAB/서명·테스트 트랙 3~5인일, 스토어 자료·계정 연결·상태 추적 3~5인일, 비용 집계·예산 상한 1~3인일, iOS 실행기·서명·TestFlight 5~10인일입니다. 실제 요구사항·계정 상태·보안 운영 범위에 따라 달라지는 설계 추정이며 출시 날짜 약속이 아닙니다. 병렬 작업 여부와 외부 등록·테스트·심사 대기를 별도로 표시합니다.

예산 기능은 프로젝트별 최대 토큰, 이미지 수, 재시도 횟수, 빌드 시간·동시 작업 수를 제한하고 예상 비용이 남은 예산을 넘으면 해당 유료 작업을 시작하지 않는 방식이 적절합니다. 크레딧 잔액을 조회할 수 없는 공급자는 “잔액 미확인”으로 표시하고 구독 크레딧을 임의로 현금 잔액처럼 계산하지 않습니다.
