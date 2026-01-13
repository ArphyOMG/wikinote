# Cornell Notes — Vercel 배포 (비개발자용)
이 폴더 그대로 GitHub에 올리고, Vercel에서 Import → Deploy만 누르면 링크가 생깁니다.

## 1) GitHub에 올리기
- GitHub에서 새 저장소 만들기 → `Add file` → `Upload files` → 이 폴더의 모든 파일을 드래그앤드롭 → Commit

## 2) Vercel 배포
- https://vercel.com → GitHub로 로그인 → `Add New Project` → 방금 만든 저장소 선택 → `Deploy`
- Framework: **Vite**, Build: 기본값, Output: `dist`

## 3) 공유
- 배포가 끝나면 `https://...vercel.app` 링크가 나오고, 그 링크를 사용자에게 공유하면 됩니다.

### 문제가 생기면
- 디자인이 이상하면: Tailwind 설정/파일들이 누락되지 않았는지 확인
- 드래그가 안 되면: `react-beautiful-dnd`가 dependencies에 있는지 확인
- ProseMirror 오류: `package.json`의 `overrides`가 그대로 있는지 확인


---

# LLM 문장 연결 기능(로컬 백엔드 포함)

이 레포에는 “문장 선택 → 근거 검색 → 관계 제안 → 승인 저장”을 위한 **로컬 Node API 서버**가 포함되어 있습니다.

## 로컬 실행(LLM 포함)
1) 의존성 설치
```bash
npm install
```

2) 백엔드 환경변수 설정
- `server/.env.example`를 참고하여 `server/.env`를 생성하고 `OPENAI_API_KEY`를 넣습니다.
```bash
cp server/.env.example server/.env
# server/.env 파일에 OPENAI_API_KEY=... 입력
```

3) 프론트 + 백엔드 동시 실행
```bash
npm run dev:all
```

- 프론트: Vite 기본 포트(예: 5173)
- 백엔드: http://localhost:4000
- Vite가 `/api/*` 요청을 백엔드로 프록시합니다.

## 배포(Vercel) 관련
Vercel “정적 프론트 배포”만으로는 `server/server.js`가 함께 실행되지 않습니다.  
LLM 기능을 배포 환경에서 사용하려면 다음 중 하나가 필요합니다.

- 별도 백엔드(예: Render/Fly.io/EC2 등)에 `server`를 배포
- 또는 Vercel/Cloudflare 등에서 서버리스 함수로 API를 이식

(현재 코드는 “붙여서 동작 확인”을 위한 MVP 구성입니다.)
