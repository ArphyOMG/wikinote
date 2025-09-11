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
