# 메뉴 기능 구현 프롬프트 템플릿

[리소스분류]의 [리소스종류] 페이지를 만들어줘.

현재 상태: `frontend/src/App.tsx`에서 Route는 있지만 `ComingSoon` 컴포넌트임.

## 해야 할 것
### 0. 기존 구현 처리 정책 (필수)
- 이 작업은 **기존 [분류]/[리소스] 구현을 ComingSoon 상태로 간주**하고 새로 구현한다.
- 기존에 해당 리소스 전용 구현이 있으면 삭제/교체해도 된다.
- 단, 다른 메뉴가 재사용하는 공통 코드는 삭제하지 않는다.
  - 예: `ResourceDetailDrawer`, `DetailCommon`, `useKubeWatchList`, 공통 API 유틸, 공통 모달/에디터
- 삭제/교체한 파일 목록과 이유를 최종 보고에 포함한다.

### 1. 리스트 페이지 생성
- 파일: `frontend/src/pages/[분류]/[Kind]s.tsx`
- 패턴: `Pods.tsx` 또는 `ClusterNodes.tsx` 참고
- 필요한 것: 검색, 네임스페이스 필터(필요 시), 새로고침, 테이블, 페이지네이션
- headlamp의 해당 리소스 페이지 참고해서 테이블 컬럼 결정

### 2. 백엔드 API 추가 (필요 시)
- `services/k8s-service/app/api.py`에 리스트/describe/delete 엔드포인트
- `services/k8s-service/app/services/k8s_service.py`에 로직
- 삭제/상세는 `404 not found`를 적절히 반환하도록 처리

### 3. 프론트 API 추가 (필요 시)
- `frontend/src/services/api.ts`에 list/describe/delete/create 함수 추가

### 4. 행 클릭 -> 상세 Drawer 열기
- `useResourceDetail().open({ kind: '[Kind]', name, namespace })`

### 5. WS Watch 실시간 갱신
- `useKubeWatchList` 패턴 적용
- watch `DELETED` 이벤트 시 리스트 상태 정합성 유지

### 6. 상세 Info 컴포넌트
- 기존 Info 컴포넌트 재사용 우선
- `Pod`는 런타임 정보(컨테이너 상태/로그/재시작/Init Container)가 많아 `WorkloadInfo`와 분리된 `PodInfo` 커스텀 유지 권장
- 새 Kind가 필요하면 `resource-detail/[Kind]Info.tsx` 생성
- `ResourceDetailDrawer.tsx`의 `renderInfoContent`에 등록

### 7. App.tsx 라우트 업데이트
- `ComingSoon` -> 실제 페이지 컴포넌트로 교체

### 8. 공통 YAML 생성 기능 (Create from YAML)
- 백엔드 공통 생성 엔드포인트가 없으면 추가:
  - `POST /cluster/resources/yaml/create`
  - 입력: `{ yaml, namespace? }`
  - 요구사항: 멀티문서 YAML, `kind: List` 지원
- 프론트 API 함수가 없으면 추가:
  - `createResourcesFromYaml(yaml, namespace?)`
- 재사용 다이얼로그가 없으면 추가:
  - 예: `ResourceYamlCreateDialog`
  - Monaco YAML Editor + `ModalOverlay`
- 리스트 상단에 `Create [Kind]` 버튼 추가 후 다이얼로그 연결

### 9. 권한 정책 (필수)
- 기본 원칙:
  - **기본값**: 생성/삭제/YAML 수정은 `write` + `admin` 허용
  - **예외(고위험/클러스터 핵심 리소스)**: `admin only`
- 현재 확정 정책(우리 서비스 기준):
  - `Node`: create/delete/yaml edit 모두 `admin only`
  - `Pod`: create/delete/yaml edit `write` + `admin`
  - `Deployment`: create/delete/yaml edit `write` + `admin`
  - `Namespace`: create/delete/yaml edit `write` + `admin`
- 구현 규칙:
  - UI 권한 숨김 + 백엔드 권한 체크를 **둘 다** 적용
  - 공통 YAML create/apply 경로도 예외 리소스(`Node`) 우회 생성/수정이 안 되게 차단
  - 정책이 다른 리소스는 `ResourceDetailDrawer`에서 kind별로 커스텀 분기

### 10. Delete 액션 정책
- 상세 Drawer의 `Info | YAML` 탭 옆 액션 영역에 Delete 배치 검토
- 삭제 시:
  - 확인 다이얼로그(`ModalOverlay`)
  - 성공 후 관련 query invalidate
  - 필요 시 Drawer 닫기
  - 위험 리소스(Node/Namespace)는 경고 문구 강화
- 삭제 직후 상세 조회 500/404 노이즈가 나지 않도록 방어:
  - not-found는 404로 응답
  - 프론트는 삭제 성공 시 Drawer 닫기 + 불필요 refetch 방지

### 11. 상세 하위 리스트(선택 적용)
- 상세 Info 안의 Pods/Events/Owned resources가 길어질 수 있으면 검색 + 페이지네이션 적용
- 필요 없는 리소스는 생략

### 12. i18n (필수)
- `frontend/src/i18n/locales/ko.json` 번역 키 추가/수정
- `frontend/src/i18n/locales/en.json` 동등 키 추가/수정
- 최소 포함:
  - 페이지 제목/설명/컬럼명
  - create/delete/confirm/warning 문구
  - 권한 관련 힌트(`admin only` 등)

### 13. 검증
- 프론트: `npm run build`
- 백엔드: 가능한 범위에서 문법/기동 검증 (`python3 -m compileall ...`)
- 변경 파일과 핵심 동작 요약 보고
- 권한 동작 확인 케이스 보고:
  - `read` 계정: create/delete/yaml edit 불가
  - `write` 계정: 허용 리소스만 가능
  - `admin` 계정: 모든 기능 가능

### 14. Headlamp 기반 상세 모달 커스텀 (필수)
- `headlamp/frontend/src/components/[resource]/Details.tsx`를 참고해 리소스별 핵심 정보 섹션 반영
- 공통 정보만으로 끝내지 말고, 리소스 특화 정보 최소 2~3개 이상 추가
- 예시(리소스별):
  - `Node`: Capacity/Allocatable, Addresses, Taints, Scheduling 상태
  - `Namespace`: ResourceQuota, LimitRange, Lifecycle(finalizers/owner refs)
  - `Pod`: QoS/Priority, PodIPs/HostIPs, Init Containers, Lifecycle
  - `Deployment`: Strategy(rolling params), Revision/Generation, Progress 상태
  - `StatefulSet`: ServiceName, PodManagementPolicy, UpdateStrategy(partition), VolumeClaimTemplates, Revision
- 구현 원칙:
  - 1차: 기존 API 응답 + `rawJson`으로 구성
  - 2차: 부족한 필드만 백엔드 `describe` 확장
  - 공통 컴포넌트(`DetailCommon`) 재사용, 필요 시 kind별 `*Info.tsx` 커스텀
- UI 품질 기준:
  - 긴 문자열/긴 조건명 줄바꿈 처리(겹침 금지)
  - 섹션 과다 시 검색 + 페이지네이션 적용
  - 모바일/좁은 폭에서도 레이아웃 깨짐 없음
- 보고 항목:
  - Headlamp 대비 추가/차이점을 리소스별 1~2줄로 요약해서 제출

### 15. 상세 Key/Value UI 정리 (필수 검토)
- YAML 성격의 key/value 데이터를 그대로 길게 한 줄로 나열하지 말고, 읽기 쉬운 형태로 정리
- 특히 `Containers` 섹션은 기존 구현(`PodInfo`, `WorkloadInfo`의 Deployment/StatefulSet/DaemonSet)을 참고해서 동일 톤으로 표시
- UI 가이드:
  - 라벨/값 2열 구조(`Label | Value`) 우선
  - 긴 문자열(`command`, `args`, `message`, `image`)은 줄바꿈(`break-words`, `whitespace-pre-wrap`) 처리
  - 리스트/맵(`ports`, `requests`, `limits`, `mounts`, `env`)은 칩(tag) 또는 행 분리로 표현
  - 값이 없으면 `-`로 명확히 표기
  - 모바일/좁은 폭에서도 겹침 없이 유지
- 구현 원칙:
  - 동일한 표현이 2개 이상 리소스에서 반복되면 `DetailCommon`에 공통 렌더 유틸/컴포넌트로 승격 검토
  - 리소스별 의미가 크게 다르면 각 `*Info.tsx`에서 커스텀 유지
  - 변경 시 `Pod`, `Deployment`, `StatefulSet`, `DaemonSet`은 최소 한 번씩 확인
- 보고 항목:
  - 어떤 섹션을 공통화했고, 어떤 섹션을 커스텀으로 남겼는지 2~3줄 요약 제출

## 참고할 기존 코드 / 공통 코드
- 페이지 패턴:
  - `frontend/src/pages/workloads/Pods.tsx`
  - `frontend/src/pages/workloads/Deployments.tsx`
  - `frontend/src/pages/ClusterNodes.tsx`
  - `frontend/src/pages/Namespaces.tsx`
- 상세 Drawer/Info:
  - `frontend/src/components/ResourceDetailDrawer.tsx`
  - `frontend/src/components/resource-detail/WorkloadInfo.tsx`
  - `frontend/src/components/resource-detail/PodInfo.tsx`
  - `frontend/src/components/resource-detail/NodeInfo.tsx`
  - `frontend/src/components/resource-detail/NamespaceInfo.tsx`
  - `frontend/src/components/resource-detail/DetailCommon.tsx`
- Watch/실시간 갱신:
  - `frontend/src/services/useKubeWatchList.ts`
  - `frontend/src/services/watchMultiplexer.ts`
- YAML/모달 공통:
  - `frontend/src/components/YamlEditor.tsx`
  - `frontend/src/components/ResourceYamlCreateDialog.tsx`
  - `frontend/src/components/ModalOverlay.tsx`
- API 레이어:
  - `frontend/src/services/api.ts`
  - `services/k8s-service/app/api.py`
  - `services/k8s-service/app/services/k8s_service.py`
- 라우팅:
  - `frontend/src/App.tsx`
- 번역:
  - `frontend/src/i18n/locales/ko.json`
  - `frontend/src/i18n/locales/en.json`
- Headlamp 참고(리소스 상세):
  - `headlamp/frontend/src/components/pod/Details.tsx`
  - `headlamp/frontend/src/components/node/Details.tsx`
  - `headlamp/frontend/src/components/namespace/Details.tsx`
  - `headlamp/frontend/src/components/workload/Details.tsx`
  - `headlamp/frontend/src/components/statefulset/Details.tsx`
