(() => {
  'use strict';
  const root=document.documentElement;
  const t=(ko,en)=>root.lang==='ko'?ko:en;
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={permission:'read',trace:'0',depth:'context',arch:'frontend'};
  const paragraph=(ko,en)=>'<p>'+esc(t(ko,en))+'</p>';
  const list=items=>'<ul>'+items.map(pair=>'<li>'+esc(t(...pair))+'</li>').join('')+'</ul>';
  const flow=labels=>'<div class="signal-flow" aria-hidden="true">'+labels.map(label=>'<b>'+esc(label)+'</b>').join('<i></i>')+'</div>';
  function stack(id,variants,selected){
    const target=document.getElementById(id);
    target.innerHTML=Object.entries(variants).map(([key,html])=>'<div data-copy="'+esc(key)+'" data-active="'+(selected===key)+'" aria-hidden="'+(selected!==key)+'"'+(selected!==key?' inert':'')+'>'+html+'</div>').join('');
  }
  function selectStack(id,selected){document.getElementById(id).querySelectorAll('[data-copy]').forEach(node=>{const active=node.dataset.copy===selected;node.dataset.active=String(active);node.setAttribute('aria-hidden',String(!active));node.inert=!active;});}
  function press(attribute,value){document.querySelectorAll('['+attribute+']').forEach(button=>button.setAttribute('aria-pressed',String(button.getAttribute(attribute)===value)));}
  // The built-in roles of v0.7.9 (auth-service repository.SeedSystemRoles) and what the chat does with each request
  // (ai-service ai/screen_permissions.py and ai/permissions.py, tool_whitelists.WRITE_TOOL_NAMES, redact.py).
  const roles={read:'Read',write:'Write',admin:'Admin'};
  const requests=[
    {ko:'로그·이벤트 조회',en:'Read logs and events',read:'ok',write:'ok',admin:'ok'},
    {ko:'Pod 재시작 같은 변경',en:'A change, such as restarting a Pod',read:'no',write:'approve',admin:'approve'},
    {ko:'Secret 값',en:'Secret values',read:'no',write:'maskAI',admin:'maskAI'},
    {ko:'컨테이너 exec · 롤아웃 되돌리기',en:'exec into a container · rollout undo',read:'no',write:'adminOnly',admin:'approve'}
  ];
  const outcomes={ok:['ok','조회','read'],approve:['approve','승인 후 실행','after approval'],no:['no','권한 없음','not allowed'],mask:['mask','가림','masked'],maskAI:['mask','AI엔 가림','masked for AI'],adminOnly:['no','Admin만','Admin only']};
  function renderPermission(){
    press('data-permission',state.permission);
    const role=roles[state.permission];
    document.getElementById('permission-label').textContent=role;
    document.getElementById('permission-person-role').textContent=role;
    document.getElementById('permission-targets').innerHTML=requests.map(r=>{const [kind,ko,en]=outcomes[r[state.permission]];return '<span class="target" data-outcome="'+kind+'"><span>'+esc(t(r.ko,r.en))+'</span><i>'+esc(t(ko,en))+'</i></span>';}).join('');
    document.getElementById('permission-list').innerHTML=requests.map(r=>{const [,ko,en]=outcomes[r[state.permission]];return '<li>'+esc(role)+' · '+esc(t(r.ko,r.en))+': '+esc(t(ko,en))+'</li>';}).join('');
    document.getElementById('permission-proof').textContent=t('사용자('+role+' 역할)로 조회 · 읽기 전용 · 클러스터 요청 2건','Ran as: user · role '+role+' · whole cluster · read-only · Cluster requests (2)');
    selectStack('permission-caption',state.permission);
    document.dispatchEvent(new Event('kubeast:permission'));
  }
  function renderTrace(){press('data-trace',state.trace);selectStack('trace-log',state.trace);document.getElementById('trace-next').textContent=state.trace==='3'?t('승인하고 결과 보기','Approve and view result'):state.trace==='4'?t('처음부터','Start over'):t('다음 단계','Next step');}
  function renderDepth(){press('data-depth',state.depth);selectStack('depth-detail',state.depth);selectStack('depth-copy',state.depth);document.dispatchEvent(new CustomEvent('kubeast:scene',{detail:{key:state.depth}}));}
  function renderArch(){press('data-arch',state.arch);selectStack('arch-notes',state.arch);}
  function renderAll(){
    stack('permission-caption',{
      read:paragraph('Read에게 AI는 조회 도구만 씁니다. 변경을 부탁하면 역할에 그 권한이 없다고 답하고 아무것도 실행하지 않습니다. Read에게는 클러스터가 Secret과 Helm 릴리스를 거절하고, 어떤 역할이든 Secret 값은 AI에 전달되지 않습니다.','For Read, the AI uses read tools only. Asked for a change, it says the role does not allow it and runs nothing. The cluster refuses Secrets and Helm releases to Read, and no role sends Secret values to the AI.'),
      write:paragraph('Write는 만들기·고치기·지우기와 Helm 업그레이드·롤백을 할 수 있고, 콘솔에서 Secret 값을 볼 수 있습니다. 컨테이너 exec와 롤아웃 되돌리기는 Admin 권한입니다.','Write can create, edit and delete, upgrade or roll back Helm releases, and show Secret values in the console. exec into a container and rollout undo need Admin.'),
      admin:paragraph('Admin은 모든 권한을 가집니다. 그래도 AI의 변경은 승인 카드를 거치고, 모든 도구 호출이 감사 기록에 남습니다.','Admin holds every permission. AI changes still wait on an approval card, and every tool call goes to the audit log.')
    },state.permission);
    stack('trace-log',{
      '0':'<span class="dialog-speaker">YOU</span><strong>'+t('checkout-api를 복구하고 싶어요.','Help me recover checkout-api.')+'</strong>'+paragraph('commerce에서 재시작 중인 Pod와 최근 배포를 함께 살펴보세요.','Look at the restarting Pod and its latest rollout in commerce.'),
      '1':'<span class="dialog-speaker">KUBEAST · TOOLS</span><strong>Pod → events → previous logs</strong>'+paragraph('이전 컨테이너 로그에서 PAYMENT_GATEWAY_URL 누락을 확인합니다. Deployment의 환경 설정과 최근 변경을 이어서 조회합니다.','Previous logs show a missing PAYMENT_GATEWAY_URL. Inspect the Deployment configuration and recent changes next.'),
      '2':'<span class="dialog-speaker">KUBEAST</span><strong>'+t('변경할 내용부터 확인합니다.','Review the proposed change.')+'</strong><pre class="flow-diff">  Deployment / commerce / checkout-api\n+ envFrom: configMapRef / checkout-config</pre>'+paragraph('설정 참조를 복구하는 안입니다. 대상과 바뀌는 내용을 확인한 뒤 실행을 결정합니다.','Restore the configuration reference. Review the target and the change before deciding to proceed.'),
      '3':'<span class="dialog-speaker">YOUR APPROVAL</span><strong>'+t('이 변경을 진행할까요?','Proceed with this change?')+'</strong>'+paragraph('대상: commerce / checkout-api. 승인 전까지 변경을 기다립니다.','Target: commerce / checkout-api. The change waits for your approval.')+'<button type="button" class="flow-approve" data-flow-approve>'+t('승인하고 계속','Approve and continue')+'</button>',
      '4':'<span class="dialog-speaker">KUBEAST · RESULT</span><strong>'+t('변경 결과와 새 상태를 확인합니다.','Check the result and the new state.')+'</strong><div class="flow-result">✓ Deployment updated · 1/1 Ready</div>'+paragraph('실행 결과를 대화에서 확인하고, 감사 기록에서 실행 주체와 작업 결과를 따라갑니다.','Read the result in the conversation, then follow the actor and operation outcome in the audit trail.')
    },state.trace);
    const sceneCopy={
      context:{title:t('Pod가 재시작하는 이유를 찾습니다.','Investigate a restarting Pod.'),body:t('선택한 리소스의 상태, 이벤트, 직전 로그를 함께 확인합니다. 조회에 사용한 도구와 결과도 답 안에서 열어 볼 수 있습니다.','Inspect the resource state, events and previous logs together. Open the tool calls and results behind the answer.'),tools:'k8s_get_resources · k8s_get_pod_logs',source:'Kubernetes',scope:'commerce / checkout-api'},
      evidence:{title:t('로그와 느린 요청을 함께 봅니다.','Follow errors across logs and traces.'),body:t('Loki에서 오류를 찾고 Tempo의 trace와 span을 확인합니다. 같은 시간대의 지표와 비교해 원인을 좁혀 갑니다.','Find errors in Loki, inspect traces and spans in Tempo, then compare metrics from the same time window.'),tools:'loki_query · traces_search · traces_get',source:'Loki · Tempo',scope:'commerce / checkout-api'},
      change:{title:t('어디에 비용이 드는지 확인합니다.','Find where the cluster spends.'),body:t('OpenCost의 Namespace별 배분과 requests 대비 사용량을 읽습니다. 비용과 자원 사용량을 함께 보고 조정할 대상을 고릅니다.','Read OpenCost allocations and compare resource requests with usage. Review costs and utilization before choosing a change.'),tools:'cost · optimization',source:'OpenCost · Prometheus',scope:'commerce / 24h'},
      choice:{title:t('릴리스 이력과 바뀐 값을 읽습니다.','Review release history and changes.'),body:t('Helm 릴리스의 이력, values, 리비전 차이를 확인합니다. AI는 릴리스를 읽기만 하고, 업그레이드·롤백은 Helm 화면에서 dry-run 미리보기를 거쳐 실행합니다.','Inspect Helm history, values and revision differences. The AI only reads releases; an upgrade or rollback runs on the Helm screen after a dry-run preview.'),tools:'helm_read · can_i',source:'Helm',scope:'commerce / storefront'},
      alerts:{title:t('알림에서 원인과 다음 확인 사항으로.','From an alert to evidence and next steps.'),body:t('발생한 알림을 고르고 관련 리소스·이벤트·로그를 읽습니다. 조사 보고서의 근거를 열어 보고 같은 맥락으로 질문을 이어 갑니다.','Select an alert and read its resources, events and logs. Open the evidence in its report, then continue the conversation in context.'),tools:'alerts_inbox · alert_investigate',source:'Alertmanager · Kubernetes',scope:'commerce / KubePodCrashLooping'},
      audit:{title:t('누가, 무엇을, 언제 바꿨는지.','See who changed what, and when.'),body:t('사용자·작업·결과로 감사 기록을 좁힙니다. 실행 주체·대상·결과를 확인하고, Helm 변경은 기록에 남은 리비전 번호로 이어서 살펴봅니다.','Filter the audit trail by actor, action and result. Inspect the actor, target and outcome. For Helm changes, follow the revision numbers kept in the record.'),tools:'audit_search',source:'Kubeast audit records',scope:'commerce / checkout-api'}
    };
    const descriptions={},terminals={};
    for(const [key,item] of Object.entries(sceneCopy)){
      descriptions[key]='<h3>'+esc(item.title)+'</h3><p>'+esc(item.body)+'</p><dl class="workflow-facts"><dt>'+t('대상','Scope')+'</dt><dd>'+esc(item.scope)+'</dd><dt>'+t('연결','Sources')+'</dt><dd>'+esc(item.source)+'</dd><dt>'+t('도구','Tools')+'</dt><dd>'+esc(item.tools)+'</dd></dl>';
      terminals[key]='<div class="run-header"><div class="run-identity"><img src="icon.svg" width="27" height="27" alt=""><div><b>'+esc(item.scope)+'</b><small>'+t('예시 실행 흐름','Sample run')+'</small></div></div><div class="run-controls"><button type="button" data-run-toggle aria-label="'+t('예시 애니메이션 일시정지','Pause example animation')+'">Ⅱ</button><button type="button" data-run-replay aria-label="'+t('예시 다시 재생','Replay example')+'">↻</button></div></div><div class="terminal-lines" aria-hidden="true"></div><div class="terminal-accessible sr-only"></div><div class="run-footer"><span class="run-status"></span><span>'+t('예시 데이터','Sample data')+'</span></div>';
    }
    stack('depth-copy',descriptions,state.depth);stack('depth-detail',terminals,state.depth);
    const arch=(title,description,items)=>'<h3>'+esc(t(...title))+'</h3>'+paragraph(...description)+list(items);
    stack('arch-notes',{
      frontend:arch(['Web console','Web console'],['React와 TypeScript로 만든 같은 프런트에서 리소스, AI, 터미널을 엽니다. 이 페이지의 체험도 같은 프런트에 예시 API 데이터를 연결합니다.','One React and TypeScript frontend hosts resources, AI and terminals. The demo on this page uses this code with sample API data.'],[['브라우저의 요청은 Gateway로 모입니다.','Browser requests go through the Gateway.'],['목록·상세 서랍·채팅이 화면 정보를 공유합니다.','Lists, resource drawers and chat share screen context.']]),
      gateway:arch(['Gateway','Gateway'],['NGINX Gateway가 요청을 맞는 서비스로 보냅니다. 일반 조회뿐 아니라 채팅 스트리밍과 로그·터미널 연결도 전달합니다.','The NGINX Gateway routes requests to the appropriate service, including chat streams and log or terminal connections.'],[['HTTP · SSE · WebSocket을 전달합니다.','Routes HTTP, SSE and WebSocket traffic.'],['사용자 권한 판단은 각 서비스가 담당합니다.','Services enforce the user’s access rights.']]),
      auth:arch(['인증과 접근 관리','Identity and access'],['Auth 서비스가 로그인, 조직·팀·역할과 등록 클러스터를 관리합니다. 지속해서 남겨야 할 정보는 PostgreSQL에 저장합니다.','Auth manages sign-in, organizations, teams, roles and registered clusters. Persistent state is stored in PostgreSQL.'],[['클러스터·Namespace별 권한을 구분합니다.','Access is scoped by cluster and namespace.'],['UI와 AI 모두 사용자의 범위 안에서 동작합니다.','Both the UI and AI operate within the user’s scope.']]),
      k8s:arch(['Kubernetes 서비스','Kubernetes service'],['Kubernetes 서비스가 리소스·Helm·토폴로지와 클러스터 연결을 담당합니다. 로그와 exec는 스트리밍 연결로 전달합니다.','The Kubernetes service handles resources, Helm, topology and cluster connections. Logs and exec use streaming connections.'],[['등록 클러스터의 Kubernetes API에 연결합니다.','Connects to registered Kubernetes APIs.'],['설정에 따라 Valkey 또는 메모리 캐시를 사용합니다.','Uses Valkey or in-memory caching according to configuration.']]),
      ai:arch(['AI와 도구 호출','AI and tool calls'],['AI 서비스가 모델과 대화를 조율하고 허용된 도구를 호출합니다. 도구 서버는 사용자의 범위에서 선택한 클러스터를 조회합니다.','The AI service coordinates model conversations and allowed tool calls. The tool server reads the selected cluster within the user’s scope.'],[['모델 제공자는 별도로 설정합니다.','Model providers are configured separately.'],['조회 결과를 대화로 스트리밍합니다.','Results stream back into the conversation.']]),
      session:arch(['대화 기록','Conversation history'],['Session 서비스가 채팅 세션과 메시지 기록을 담당합니다. 화면을 이동하거나 대화를 다시 열어도 기록에서 이전 질문과 답을 살펴볼 수 있습니다.','The Session service manages chat sessions and message history, so previous questions and answers remain available when returning to a conversation.'],[['대화 기록과 현재 리소스 상태는 구분합니다.','Conversation history and current resource state are distinct.'],['보관 정책과 접근 범위는 운영 설정을 따릅니다.','Retention and access follow the deployment configuration.']]),
      // Entry points, what the services reach and where data is kept, as v0.7.9 ships them: docs/ai-alerts.md, docs/features.md (roles table), docs/database-backup-restore.md, docs/security-audit.md "Audit sinks", helm/kubeast/values.yaml defaults.
      mcp:arch(['AI 에이전트 연결 (MCP)','AI agents over MCP'],['Claude Code나 Cursor 같은 AI 에이전트가 kubeconfig 대신 API 키로 연결합니다. 채팅과 같은 읽기 도구를 키를 만든 사람의 권한 안에서만 씁니다.','AI agents such as Claude Code or Cursor connect with an API key instead of a kubeconfig. They use the chat’s read tools within the permissions of the person who made the key.'],[['선택 기능이며 기본으로 꺼져 있습니다. 차트 값 mcp.enabled로 켭니다.','Optional and off by default; the chart value mcp.enabled turns it on.'],['도구 결과는 가린 뒤 보내고, 모든 호출을 감사 기록에 남깁니다.','Results are masked before they are sent, and every call goes to the audit log.']]),
      alerts:arch(['알림 조사','Alert investigation'],['Alertmanager나 Grafana가 웹훅으로 알림을 보내면 AI가 먼저 조사하고 보고서를 남깁니다. 조사는 읽기 전용 그룹으로 클러스터를 읽습니다.','When Alertmanager or Grafana sends an alert to the webhook, the AI looks into it first and leaves a report. The investigation reads the cluster as a read-only group of its own.'],[['선택 기능이며 기본으로 꺼져 있습니다. 차트 값 features.alertInvestigation.enabled로 켭니다.','Optional and off by default; the chart value features.alertInvestigation.enabled turns it on.'],['시간당 조사 수와 하루 토큰 예산으로 사용량을 제한합니다.','An hourly cap and a daily token budget limit how much it runs.']]),
      models:arch(['모델 제공자','Model providers'],['AI 서비스가 설정한 모델 제공자에 질문과 도구 결과를 보냅니다. OpenAI, Anthropic, Gemini와 직접 운영하는 Ollama 같은 OpenAI 호환 API를 쓸 수 있습니다.','The AI service sends questions and tool results to the model provider you set up: OpenAI, Anthropic, Gemini, or an OpenAI-compatible API such as Ollama run in-house.'],[['비밀번호·키·토큰 같은 값과 Secret 값은 보내기 전에 가립니다.','Passwords, keys, tokens and Secret values are masked before anything is sent.'],['내부 Ollama 모델을 쓰면 데이터가 네트워크 밖으로 나가지 않습니다.','With an in-house model in Ollama, the data stays in your network.']]),
      clusters:arch(['등록한 클러스터','Registered clusters'],['Kubeast가 설치된 클러스터는 처음부터 연결되고, 다른 클러스터는 kubeconfig로 추가합니다. 기본 설정에서는 화면의 요청과 AI 도구의 요청 모두 로그인한 사용자의 역할로 전달되어, 클러스터의 RBAC가 한 번 더 확인합니다.','The cluster Kubeast runs in is connected from the start; others are added with a kubeconfig. By default, requests from the screens and from AI tools alike reach the cluster as the signed-in user’s role, so the cluster’s own RBAC checks them again.'],[['Read는 view, Write는 edit, Admin은 cluster-admin을 바탕으로 한 그룹으로 요청합니다.','Read goes as a group built on view, Write on edit and Admin on cluster-admin.'],['클러스터의 감사 로그에도 요청한 사람이 남습니다.','The cluster’s own audit log names the person who asked.']]),
      observability:arch(['관측 도구','Observability tools'],['클러스터마다 Prometheus 지표, OpenCost 비용, Kyverno 정책 보고서, Hubble 네트워크 흐름, Loki 로그를 연결할 수 있습니다. Tempo 트레이스는 AI 도구가 읽습니다.','Per cluster, connect Prometheus metrics, OpenCost costs, Kyverno policy reports, Hubble network flows and Loki logs. Tempo traces are read by the AI tools.'],[['도구마다 설치와 연결 설정이 필요하고, 로그 검색·트레이스·네트워크 흐름은 기본으로 꺼져 있습니다.','Each needs the tool installed and connected; log search, traces and network flows are off by default.'],['클러스터 안의 Prometheus·OpenCost·Hubble은 API 서버를 거쳐 사용자 권한으로 읽습니다.','Prometheus, OpenCost and Hubble inside a cluster are read through its API server, as the user.']]),
      postgres:arch(['PostgreSQL','PostgreSQL'],['사용자·역할·등록한 클러스터, 대화 기록, 감사 기록처럼 오래 남길 정보를 PostgreSQL 하나에 저장합니다. 차트가 클러스터 안에 설치하거나, 직접 운영하는 PostgreSQL을 연결합니다.','Users, roles, registered clusters, conversations and audit records are kept in one PostgreSQL database: the one the chart installs in the cluster, or your own.'],[['클러스터의 kubeconfig와 모델 API 키는 데이터베이스가 아닌 Secret에 둡니다.','Cluster kubeconfigs and model API keys live in Secrets, not in the database.'],['감사 기록은 앞 기록과 해시로 이어져, 바뀌거나 지워진 기록이 없는지 검증할 수 있습니다.','Each audit record is chained to the one before it by hash, so a changed or removed record can be found.']]),
      sinks:arch(['감사 기록 사본','Audit copies'],['감사 기록의 원본은 PostgreSQL에 두고, 사본을 밖으로 내보낼 수 있습니다. S3(Object Lock), 웹훅(SIEM·Slack 등), 이메일, 파일 중에서 고릅니다.','The audit log stays in PostgreSQL, and copies can go out: to S3 (with Object Lock), a webhook (a SIEM, Slack and others), email or a file.'],[['선택 기능이며 기본으로는 아무 곳에도 보내지 않습니다. 차트 값 audit.sinks로 정합니다.','Optional; nothing is sent by default. The chart value audit.sinks sets where.'],['아직 보내지 못한 기록은 보존 기간이 지나도 지우지 않습니다.','Records not yet sent are kept even past the retention period.']]),
      secrets:arch(['Kubernetes Secret','Kubernetes Secrets'],['등록한 클러스터의 kubeconfig는 Auth 서비스가 Kubeast의 Namespace에 Secret으로 저장합니다. 모델 API 키와 로그인 서명 키도 Secret에 둡니다.','Auth stores each registered cluster’s kubeconfig as a Secret in Kubeast’s namespace. Model API keys and the sign-in signing keys are Secrets too.'],[['Kubeast가 설치된 클러스터에서 이 Namespace의 Secret 조회와 변경은 전체 관리자만 할 수 있습니다.','On the cluster it runs in, only global admins may read those Secrets or change anything in that namespace.'],['Secret은 데이터베이스 백업에 들어가지 않으니 따로 보관합니다.','Secrets are not in the database dump, so keep them from their own source.']]),
      cache:arch(['Valkey 캐시','Valkey cache'],['Kubernetes 서비스가 클러스터 조회 결과를 Valkey(Redis 호환)에 최대 한 시간 캐시합니다. Valkey를 끄면 같은 캐시를 메모리에 둡니다.','The Kubernetes service caches cluster reads in Valkey (Redis-compatible) for up to an hour. With Valkey off, it keeps the cache in memory.'],[['캐시 키는 kubeast: 아래에만 두고, 서비스마다 자기 Redis 사용자로 접속합니다.','Keys stay under kubeast:, and each service signs in as its own Redis user.'],['기본 설치에 들어 있고, 최소 설치에서는 빠집니다.','Included by default; the minimal install leaves it out.']])
    },state.arch);
    renderPermission();renderTrace();renderDepth();renderArch();

    document.querySelector('.permission-switch').setAttribute('aria-label',t('권한 예시','Permission examples'));
    document.querySelector('.depth-choices').setAttribute('aria-label',t('제품의 특징','Product capabilities'));
    document.querySelector('.arch-diagram').setAttribute('aria-label',t('Kubeast 운영 구조','Kubeast architecture'));
    document.querySelector('.lb-close').setAttribute('aria-label',t('영상 닫기','Close video'));
    document.querySelector('[data-prev]').setAttribute('aria-label',t('이전 영상','Previous video'));
    document.querySelector('[data-next]').setAttribute('aria-label',t('다음 영상','Next video'));
    document.querySelectorAll('.card').forEach(card=>card.setAttribute('aria-label',card.querySelector('h3 [lang="'+root.lang+'"]').textContent+' · '+t('영상 보기','watch video')));
  }
  [['permission',renderPermission],['trace',renderTrace],['depth',renderDepth],['arch',renderArch]].forEach(([key,render])=>document.querySelectorAll('[data-'+key+']').forEach(button=>button.addEventListener('click',()=>{state[key]=button.getAttribute('data-'+key);render();})));
  document.getElementById('trace-next').addEventListener('click',()=>{state.trace=String((Number(state.trace)+1)%5);renderTrace();});
  document.getElementById('trace-log').addEventListener('click',event=>{if(event.target.closest('[data-flow-approve]')){state.trace='4';renderTrace();document.dispatchEvent(new Event('kubeast:flow-approved'));}});
  document.getElementById('trace-reset').addEventListener('click',()=>{state.trace='0';renderTrace();});
  new MutationObserver(renderAll).observe(root,{attributes:true,attributeFilter:['lang']});

  // The demo: eight screens of the released console (demo/, built by site-demo/build.sh) on sample data answered in the
  // page, never by a server. It starts loading when its section comes near, after the first screen and the recordings.
  // On a phone the frame holds AI Chat only; the other screens show their recording or a short note.
  (()=>{
    const shell=document.getElementById('demo-shell'),frame=document.getElementById('product-demo'),viewport=document.getElementById('demo-viewport'),canvas=viewport.querySelector('.demo-canvas'),poster=document.getElementById('demo-poster'),video=poster.querySelector('video'),posterText=poster.querySelector('.demo-poster-text'),caption=poster.querySelector('figcaption p'),line=document.getElementById('demo-state');
    const narrow=matchMedia('(max-width: 760px)'),still=matchMedia('(prefers-reduced-motion: reduce)');
    const routes={overview:'/overview',cluster:'/cluster-view',pods:'/workloads/pods',monitoring:'/monitoring',cost:'/cost',helm:'/helm/releases',audit:'/admin/audit',chat:'/ai-chat'};
    const clips={overview:'dashboard',pods:'resource-drawer',helm:'helm',audit:'access-audit'};
    const notes={cluster:['Cluster View','Node마다 놓인 Pod를 지도와 카드로 보고, Pod를 열어 이어지는 로그를 봅니다.','Every node’s Pods on a map and as cards; open a Pod to follow its log.'],monitoring:['Monitoring','Node와 Pod의 CPU·메모리 사용량을 표로 보고 Namespace로 좁힙니다.','Node and Pod CPU and memory usage in tables, narrowed by namespace.'],cost:['Cost','OpenCost 비용을 Namespace·워크로드별로, 고른 기간에 맞춰 비교합니다.','OpenCost allocations by namespace and workload, over the window you choose.']};
    let route='chat',mode='',loaded=false,started=false,chosen=false;
    const shown=()=>mode==='phone'?'chat':route;
    const hash=()=>'#'+routes[shown()]+'?'+new URLSearchParams({cluster:'default',lang:root.lang}).toString();
    function address(){const [path,query='']=(frame.dataset.src||'demo/').split('?');const params=new URLSearchParams(query);if(mode==='phone')params.set('phone','1');const q=params.toString();return path+(q?'?'+q:'')+hash();}
    function open(){started=true;loaded=false;frame.style.visibility='hidden';frame.src=address();}
    function go(){if(!started)return open();if(!loaded)return open();try{if(frame.contentWindow.location.hash!==hash())frame.contentWindow.location.hash=hash();}catch(e){open();}}
    // The page's language in the frame's own address: what is open there (a drawer, a release's page) stays.
    function speak(){if(!started||!loaded)return go();try{const at=frame.contentWindow.location,[path,query='']=at.hash.slice(1).split('?'),params=new URLSearchParams(query);if(params.get('lang')===root.lang)return;params.set('lang',root.lang);at.hash='#'+path+'?'+params.toString();}catch(e){open();}}
    function stopVideo(){video.pause();}
    function showRecording(key){
      const clip=clips[key],card=clip&&document.querySelector('.card[data-clip="'+clip+'"]');
      video.hidden=!card;posterText.hidden=!!card;
      if(card){const source=card.querySelector('video');video.poster=source.getAttribute('poster');if(video.dataset.clip!==clip){video.dataset.clip=clip;video.src=source.dataset.src;}video.controls=still.matches;if(!still.matches)video.play().catch(()=>{});caption.textContent=t('녹화 영상 · ','Recording · ')+card.querySelector('h3 [lang="'+root.lang+'"]').textContent;}
      else{stopVideo();const [title,ko,en]=notes[key];posterText.innerHTML='<b>'+esc(title)+'</b><span>'+esc(t(ko,en))+'</span>';caption.textContent=t('예시 데이터 화면','Sample data screen');}
    }
    function hint(){
      if(mode==='phone')return shown()===route?t('준비된 질문을 누르거나 같은 질문을 입력해 보세요.','Pick a prepared question or type it.'):'';
      return route==='chat'?t('예시 질문을 보내고 도구 결과와 대화 기록을 확인하세요.','Send a sample question and explore tool results and history.'):route==='cluster'?t('예시 데이터 · Pod 카드를 누르면 로그가 열리고 새 줄이 이어서 나옵니다.','Sample data · click a Pod card to open its log, which follows new lines.'):route==='pods'||route==='helm'?t('지우기·적용 같은 버튼은 이 페이지의 예시 데이터만 바꿉니다.','Buttons such as delete and apply change only this page’s sample data.'):t('예시 데이터 · 필터와 항목을 눌러 살펴보세요.','Sample data · explore the filters and items.');
    }
    function show(){
      press('data-demo-route',route);
      const recording=mode==='phone'&&route!=='chat';
      viewport.hidden=recording;poster.hidden=!recording;
      if(recording)showRecording(route);else{stopVideo();go();}
      line.textContent=hint();
    }
    function fit(){
      if(mode==='phone'){canvas.style.width=canvas.style.height=viewport.style.height=frame.style.transform='';return;}
      const scale=Math.min(1,Math.max(.74,viewport.clientWidth/1280));canvas.style.width=(1280*scale)+'px';canvas.style.height=(700*scale)+'px';viewport.style.height=(700*scale)+'px';frame.style.transform='scale('+scale+')';
    }
    function setMode(){const next=narrow.matches?'phone':'desktop';if(next===mode)return;const before=mode;mode=next;shell.dataset.mode=mode;if(!chosen)route='chat';fit();if(before&&started){loaded=false;show();}else{press('data-demo-route',route);line.textContent=hint();}}
    // On a computer the frame is a 1280×700 window, on a phone AI Chat at the phone's width and 640 px tall: demo-frame.css
    // fits each screen into it, and the frame shows once it has.
    const sheet=new URL('demo-frame.css',document.baseURI),version=new URLSearchParams((frame.dataset.src||'').split('?')[1]||'').get('v');if(version)sheet.searchParams.set('v',version);
    function fitScreens(){
      const done=()=>{frame.style.visibility='';};
      try{const page=frame.contentDocument,link=page.createElement('link');link.rel='stylesheet';link.href=sheet.href;link.onload=link.onerror=done;page.head.appendChild(link);}catch(e){done();}
    }
    frame.addEventListener('load',()=>{loaded=true;fitScreens();});
    document.querySelectorAll('[data-demo-route]').forEach(button=>button.addEventListener('click',()=>{route=button.dataset.demoRoute;chosen=true;show();}));
    new ResizeObserver(fit).observe(viewport);
    narrow.addEventListener('change',setMode);
    setMode();
    new IntersectionObserver((items,observer)=>{if(items.some(item=>item.isIntersecting)){observer.disconnect();show();}},{rootMargin:'400px 0px'}).observe(shell);
    new MutationObserver(()=>{if(!poster.hidden)showRecording(route);line.textContent=hint();if(started)speak();}).observe(root,{attributes:true,attributeFilter:['lang']});
  })();
  const lightbox=document.getElementById('lightbox');let videoOpener=null;
  function rememberOpener(event){const card=event.target.closest('.card');if(card)videoOpener=card;}
  document.addEventListener('click',rememberOpener,true);
  document.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')rememberOpener(event);},true);
  document.addEventListener('keydown',event=>{
    if(lightbox.hidden||event.key!=='Tab')return;
    const items=Array.from(lightbox.querySelectorAll('button,video[controls],a[href]')).filter(node=>!node.disabled&&node.getClientRects().length);
    const first=items[0],last=items[items.length-1];if(!first)return;
    if(event.shiftKey&&(document.activeElement===first||!lightbox.contains(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!lightbox.contains(document.activeElement))){event.preventDefault();first.focus();}
  },true);
  new MutationObserver(()=>{const open=!lightbox.hidden;document.querySelector('main').inert=open;document.querySelector('header.top').inert=open;document.querySelector('footer').inert=open;if(!open&&videoOpener)videoOpener.focus({preventScroll:true});}).observe(lightbox,{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)document.querySelectorAll('video').forEach(video=>video.pause());});
  renderAll();
})();
