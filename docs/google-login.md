# Google 계정 로그인

Launchpad는 Google OpenID Connect의 서버 인증 코드 흐름을 사용합니다. Google 계정 로그인은 사용자의 신원을 확인하는 기능이며, Google AI Pro/Ultra 등 구독의 사용량 또는 유료 API 크레딧을 가져오는 기능이 아닙니다. AI 실행에 필요한 API 연결과 과금은 별도로 설정합니다.

## 운영 설정

Google Cloud Console에서 OAuth 동의 화면과 **웹 애플리케이션** OAuth 클라이언트를 만든 뒤 서버 환경 변수를 설정합니다.

```dotenv
GOOGLE_CLIENT_ID=your-web-client.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
PUBLIC_APP_URL=https://your-app.vercel.app
SESSION_SECRET=at-least-32-random-characters
# 선택: 지정한 계정만 허용. 생략하면 인증된 Google 계정을 허용합니다.
GOOGLE_ALLOWED_EMAILS=person@example.com,teammate@example.com
```

Google 콘솔의 승인된 리디렉션 URI에는 `https://your-app.vercel.app/api/auth/google/callback`을 정확히 등록합니다. `PUBLIC_APP_URL`은 경로·쿼리·해시를 포함하지 않는 고정된 사이트 origin이어야 합니다. 로컬 개발은 `http://127.0.0.1:3001` 또는 `http://localhost:3001`을 설정하고 해당 콜백 URI도 따로 등록합니다. 미리보기 Vercel 도메인은 운영 OAuth 설정과 별개로 관리합니다.

필수 설정이 없거나 올바르지 않으면 Google 로그인은 비활성화됩니다. 클라이언트 비밀 값은 `VITE_` 변수나 프런트엔드 소스에 넣지 않습니다. OAuth 동의 화면이 테스트 상태라면 허용된 테스트 계정을 Google 콘솔에 등록해야 합니다.

## 구현과 경계

- 시작 경로: `GET /api/auth/google/start`
- 콜백 경로: `GET /api/auth/google/callback`
- 상태 모듈 API: `googleAuth.status(req)` → `enabled`, `authenticated`, 안전한 `user` 프로필
- 10분짜리 서명된 HttpOnly 쿠키에 state·nonce·PKCE verifier를 보관합니다. Google에서 돌아오는 최상위 페이지 이동에 쿠키가 전달되도록 SameSite=Lax를 사용합니다.
- ID 토큰의 Google JWKS RS256 서명, issuer, audience/authorized party, 만료, nonce, subject, 이메일 인증 여부를 검증합니다. 제한 계정 목록은 매 요청의 세션 검증에도 적용합니다.
- Google issuer와 변경되지 않는 `sub`로 결정적인 UUIDv8 형태의 소유자 ID를 생성합니다. 이메일 주소는 프로젝트 소유권의 식별자로 사용하지 않습니다.
- 로그인 후 12시간짜리 서명된 HttpOnly 애플리케이션 세션을 발급합니다. HTTPS에서는 Secure 쿠키를 사용합니다. Google access/refresh/ID 토큰은 저장하거나 브라우저로 전달하지 않습니다.
- 로그아웃은 브라우저 쿠키를 삭제합니다. 현재 세션은 서버의 세션 목록에 저장되지 않으므로 별도로 복사된 세션을 즉시 폐기하는 계정별 강제 로그아웃 기능은 없습니다. 모든 세션의 강제 폐기는 `SESSION_SECRET` 회전으로 가능합니다.

별도 모의 OAuth/JWKS 테스트로 정상 로그인, 변조·만료·다른 대상 토큰 거부, PKCE/state/nonce 검증, 키 회전, 허용 계정 제한을 검증합니다. 실제 Google 로그인은 운영 OAuth 클라이언트와 정확한 도메인/콜백 등록 후 브라우저에서 확인해야 합니다.

공식 문서: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Google OIDC Discovery](https://accounts.google.com/.well-known/openid-configuration).
