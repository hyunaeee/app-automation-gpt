# Android APK 빌드

모바일 프로젝트는 생성한 HTML/CSS/JavaScript를 네이티브 Android WebView 안에 **함께 넣은 설치형 APK**입니다. 임시 미리보기 URL을 여는 앱이 아니므로 생성 서버가 꺼져도 기기에 설치한 앱은 동작합니다. 브라우저의 기기 프레임은 같은 화면을 확인하는 미리보기이며 Android OS 에뮬레이터는 아닙니다.

현재 모바일 템플릿은 기기 안에서 기록을 저장하는 오프라인 앱입니다. 서버 로그인, 기기 간 동기화, 카메라, 푸시, 결제, 백그라운드 작업은 제공하지 않습니다. 앱 삭제/데이터 삭제 시 로컬 데이터가 사라집니다. 미리보기와 APK의 저장 공간도 서로 독립적입니다.

## 로컬 빌드 도구

`server/android-builder.mjs`는 외부 패키지를 설치하거나 생성된 셸 스크립트를 실행하지 않습니다. 신뢰된 Java/Manifest 템플릿에 허용된 `public/` 파일만 넣고 설치된 Android SDK 도구를 고정된 인자로 실행합니다.

- JDK 17 이상: `JAVA_HOME`에 경로 지정. `java`, `javac`, `jar`, `keytool` 필요.
- Android SDK: `ANDROID_HOME` 또는 `ANDROID_SDK_ROOT`에 경로 지정.
- SDK Platform 34 및 Build Tools 34.0.0 이상 설치. `aapt2`, `d8`, `zipalign`, `apksigner` 필요.
- Windows/macOS/Linux의 일반 SDK 경로, `~/.jdks/jdk17`, Linux OpenJDK 17/21 경로를 추가로 찾습니다.

이미 설치된 SDK가 있으면 Android Studio나 Gradle을 실행하지 않아도 빌드할 수 있습니다. 도구가 없으면 서버가 `ANDROID_TOOLCHAIN_UNAVAILABLE`을 반환하고 필요한 설치 항목을 안내합니다. 이름만 APK인 ZIP 파일을 반환하지 않습니다.

새 빌드 머신은 [공식 Android SDK 관리 안내](https://developer.android.com/tools/sdkmanager)에 따라 SDK 명령줄 도구 및 JDK를 설치한 뒤 `sdkmanager "platforms;android-34" "build-tools;34.0.0"`으로 구성할 수 있습니다. SDK 라이선스는 운영자가 확인하고 승인해야 합니다. 에뮬레이터와 시스템 이미지, NDK는 APK 생성에 필요 없습니다. 실제 다운로드/설치 크기는 OS와 도구 버전에 따라 다르므로 고정 용량을 가정하지 마세요.

## 실행 및 결과 검증

빌드는 리소스 컴파일 → Java 컴파일 → DEX 변환 → APK 조립 → 정렬 → 개발 서명 → 서명/구조 검증으로 진행됩니다. 각 외부 프로세스는 120초 제한이 있으며, 서버 프로세스당 한 APK 빌드만 허용합니다. 취소 신호는 실행 중인 도구 프로세스도 종료합니다. API 키 등 애플리케이션 환경변수는 컴파일 도구에 전달하지 않습니다.

결과는 다음 메타데이터를 반환합니다.

```js
import { inspectAndroidToolchain, buildAndroidApk, androidSourceFiles } from '../server/android-builder.mjs';

const readiness = await inspectAndroidToolchain();
const result = await buildAndroidApk({
  projectId, name,
  files: [{ path: 'public/index.html', content: '...' }, /* app.js, styles.css */],
  directory: absoluteBuildDirectory,
  signal: abortController.signal,
  onLog: text => appendBuildLog(text),
});
// { path, filename, size, sha256, applicationId, mode: 'debug', signatureVerified: true, builtAt, logs }
const exportedFiles = androidSourceFiles({ projectId, name, files });
```

`apksigner verify`와 `zipalign -c`가 성공해야 결과가 준비됩니다. APK 내부에는 실제 `classes.dex`, 컴파일된 `AndroidManifest.xml`, `resources.arsc`, `assets/web/index.html`이 있어야 합니다. 결과 SHA-256도 계산합니다. 출력은 개발용 서명 APK이며 Google Play 배포용 릴리스 서명은 별도입니다. 동일 빌드 디렉터리의 프로젝트별 개발 키를 재사용하므로 같은 프로젝트를 업데이트 설치할 수 있습니다. 빌드 디렉터리와 키를 잃으면 기존 앱 삭제 후 재설치가 필요할 수 있습니다.

소스 ZIP은 `android/` 아래 Android Studio/Gradle 프로젝트를 포함합니다. Gradle 8.4, AGP 8.3.2, JDK 17, SDK 34로 빌드할 수 있으며 처음 Gradle 빌드에는 Google Maven 등의 의존성 다운로드가 필요합니다. 개발 서명 키, 설치된 SDK, 빌드 중간 파일, API 키, 서버 사용자 데이터는 소스 파일 목록에 포함하지 않습니다.

## WebView 범위

- `https://appassets.androidplatform.net/` 요청을 APK 내부 파일로 처리합니다. 외부 네트워크 요청이나 다른 URL로 이동할 수 없습니다.
- Android `INTERNET` 권한을 요청하지 않습니다. JavaScript는 앱 기능을 위해 허용하되 네이티브 브리지는 노출하지 않습니다.
- 파일/콘텐츠 접근, 혼합 콘텐츠, 새 창, 쿠키를 차단합니다.
- 앱 스크립트는 별도 `app.js` 같은 파일로 작성해야 합니다. 인라인 JavaScript와 외부 CDN 스크립트는 CSP가 차단합니다.
- 앱 데이터는 WebView의 기기 로컬 저장소를 사용합니다. 데이터는 백업 대상에서 제외합니다.

## Vercel 배포

Vercel 프런트엔드/API와 Android 빌드 실행기는 분리해야 합니다. 일반 Vercel 서버리스 함수에는 SDK/JDK가 준비되어 있지 않으며 큰 도구 설치·장시간 빌드를 요청마다 수행하는 구조를 가정하지 않습니다. SDK를 구성한 별도 빌드 서비스 또는 해당 도구를 포함하는 빌드 샌드박스가 같은 모듈을 실행하고, 완성된 APK를 비공개 아티팩트 저장소로 전달하도록 연결하세요. 다운로드 라우트는 프로젝트 소유권을 확인해야 합니다. 원격 실행기 미연결 상태에서는 소스만 내려받을 수 있으며 APK가 준비됐다고 표시하면 안 됩니다.

## 검증

### 원격 Android 실행기

SDK가 설치된 빌드 머신에서 `ANDROID_BUILDER_TOKEN`을 32자 이상의 무작위 값으로 설정하고 `npm run start:android-builder`를 실행합니다. 기본 주소는 `127.0.0.1:3002`이며 공개 사용 시 HTTPS 리버스 프록시 뒤에 두세요. Vercel에는 `ANDROID_BUILDER_URL`과 같은 토큰을 서버 환경 변수로 등록합니다. 실행기는 인증된 `/build` 요청의 허용된 브라우저 소스만 컴파일하며, 생성 모델의 임의 셸 명령을 실행하지 않습니다.

생성 완료 후 모바일 워크플로가 빌드를 시작합니다. 로컬은 프로젝트별 디스크, Vercel은 소유권으로 보호되는 private Blob에 APK를 보관하고 SHA-256을 확인한 뒤 다운로드합니다. 빌드 실패 시 소스는 유지하며 프로젝트 화면에서 다시 빌드할 수 있습니다. 원격 실행기 연결은 실제 배포 환경에서 별도 검증해야 합니다.

```powershell
node --test tests/android-builder.test.mjs
$env:RUN_ANDROID_BUILD_TEST='1'
node --test tests/android-builder.test.mjs
```

첫 명령은 소스 격리, 경로 검증, 도구 미설치 안내, 가짜 APK 거부, 취소를 검사합니다. 두 번째 명령은 실제 SDK로 컴파일하고 서명을 검증하며 생성한 파일을 `.data/android-build-verification/`에 남깁니다. SDK가 없는 CI에서 실제 빌드 테스트를 성공한 것으로 처리하지 않고 명시적으로 건너뜁니다.

참고: [AAPT2](https://developer.android.com/tools/aapt2), [D8](https://developer.android.com/tools/d8), [APK 서명 도구](https://developer.android.com/tools/apksigner), [앱 내부 웹 콘텐츠](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content), [명령줄 Android 빌드](https://developer.android.com/build/building-cmdline).
