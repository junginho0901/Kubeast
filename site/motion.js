(() => {
  'use strict';
  const root=document.documentElement, reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const text=(ko,en)=>root.lang==='ko'?ko:en;
  const scenes={
    context:()=>[
      ['question',text('checkout-api가 왜 재시작하나요?','Why is checkout-api restarting?')],
      ['command','k8s_get_resources  ·  Pods / commerce'],
      ['output','checkout-api   0/1   CrashLoopBackOff\nrestarts: 75   node: prod-seoul-worker-a'],
      ['command','k8s_describe_resource  ·  checkout-api'],
      ['output','Warning / BackOff\nContainer exited with code 1'],
      ['command','k8s_get_pod_logs  ·  previous=true'],
      ['output','ERROR  PAYMENT_GATEWAY_URL is not set'],
      ['result',text('환경변수 설정을 확인합니다.\nDeployment와 ConfigMap 참조가 다음 확인 대상입니다.','Check the environment configuration.\nReview the Deployment and its ConfigMap reference.')]
    ],
    evidence:()=>[
      ['question',text('checkout 요청이 느려진 시점을 찾아 주세요.','When did checkout requests slow down?')],
      ['command','loki_query  ·  {namespace="commerce"} |= "error"'],
      ['output','22m ago  upstream timeout\n    +3s  payment request exceeded deadline'],
      ['command','traces_search  ·  service=checkout-api'],
      ['output','trace: 7d91c64fe2b8\nspan checkout-api: 1.82s'],
      ['command','traces_get  ·  7d91c64fe2b8'],
      ['output','checkout → payment-gateway\npayment-gateway: 1.64s'],
      ['result',text('결제 연결 구간에서 시간이 늘었습니다.\n같은 시간대의 로그와 span을 함께 확인합니다.','Most time is spent in the payment call.\nCompare its span with logs from the same window.')]
    ],
    change:()=>[
      ['question',text('commerce의 자원 사용량과 비용을 비교해 주세요.','Compare commerce resource usage and cost.')],
      ['command','cost  ·  namespace=commerce / 24h'],
      ['output','commerce: $1.42 / 24h\ncluster: $6.68 / 24h'],
      ['command','optimization  ·  namespace=commerce'],
      ['output','storefront CPU\nrequested: 100m   observed: 77m'],
      ['result',text('storefront의 요청량을 검토합니다.\n피크 사용량과 여유를 확인한 뒤 값을 정합니다.','Review storefront CPU requests.\nCheck peak usage and headroom before changing values.')]
    ],
    choice:()=>[
      ['question',text('storefront의 최근 릴리스 차이를 보여 주세요.','Show the latest storefront release changes.')],
      ['command','helm_read  ·  history / commerce / storefront'],
      ['output','revision 8  deployed\nrevision 7  superseded'],
      ['command','helm_read  ·  diff / revisions 7..8'],
      ['output','- image.tag: 1.4.1\n+ image.tag: 1.4.2\n  replicaCount: 2'],
      ['command','can_i  ·  Helm / commerce'],
      ['result',text('차이를 확인했습니다.\n다음 변경 전에 릴리스 값과 권한을 함께 검토합니다.','Release differences reviewed.\nReview the release values and access before the next change.')]
    ],
    alerts:()=>[
      ['question',text('지금 발생한 알림을 조사해 주세요.','Investigate the firing alert.')],
      ['command','alerts_inbox  ·  firing / commerce'],
      ['output','KubePodCrashLooping · warning\ncheckout-api · firing for 22m'],
      ['command','alert_investigate  ·  KubePodCrashLooping'],
      ['output','Pod: 0/1 Ready · 75 restarts\nEvent: BackOff · exit code 1'],
      ['output','Previous logs\nERROR  PAYMENT_GATEWAY_URL is not set'],
      ['result',text('누락된 설정 참조가 확인 대상입니다.\n조사 보고서에서 근거를 열고 질문을 이어 갑니다.','Review the missing configuration reference.\nOpen the report evidence and continue the conversation.')]
    ],
    audit:()=>[
      ['question',text('checkout-api의 최근 변경을 찾아 주세요.','Find the latest change to checkout-api.')],
      ['command','audit_search  ·  commerce / checkout-api'],
      ['output','release-bot@northstar.example\nk8s.yaml.apply · success · 25m ago'],
      ['command','audit_search  ·  action=k8s.yaml.apply'],
      ['output','Deployment / checkout-api\nresource_type: deployments\nyaml_len: 846'],
      ['result',text('실행 주체와 대상을 확인했습니다.\n실제 설정은 리소스와 배포 이력에서 이어서 읽습니다.','The audit identifies the actor and target.\nInspect the resource and deployment history for its configuration.')]
    ]
  };
  const terminal=document.getElementById('depth-detail');
  let key='context',entries=[],index=0,typed=0,timer=0,paused=false,visible=false,currentRow=null;
  const panel=()=>terminal.querySelector('[data-copy="'+key+'"]');
  function cancel(){clearTimeout(timer);timer=0;}
  function status(value){const node=panel()?.querySelector('.run-status');if(node)node.textContent=value;}
  function controls(){terminal.querySelectorAll('[data-run-toggle]').forEach(b=>{b.textContent=paused?'▷':'Ⅱ';b.setAttribute('aria-label',paused?text('예시 애니메이션 재생','Play example animation'):text('예시 애니메이션 일시정지','Pause example animation'));b.setAttribute('aria-pressed',String(paused));b.disabled=reduced.matches;});terminal.classList.toggle('motion-paused',paused);}
  function makeRow(kind,value){const row=document.createElement('div');row.className='run-line run-'+kind;row.textContent=value;panel().querySelector('.terminal-lines').append(row);return row;}
  function later(ms){cancel();if(visible&&!paused&&!document.hidden&&!reduced.matches)timer=setTimeout(tick,ms);}
  function tick(){
    if(!visible||paused||document.hidden||reduced.matches)return;
    if(index>=entries.length){status(text('조회 완료','Run complete'));timer=setTimeout(reset,4800);return;}
    const [kind,value]=entries[index];
    if(!currentRow)currentRow=makeRow(kind,'');
    status(text('조회 중','Reading')+' · '+(index+1)+' / '+entries.length);
    if(kind==='command'&&typed<value.length){typed=Math.min(value.length,typed+2);currentRow.textContent='› '+value.slice(0,typed);currentRow.classList.add('typing');later(30);return;}
    currentRow.textContent=(kind==='command'?'› ':'')+value;currentRow.classList.remove('typing');
    const lines=panel().querySelector('.terminal-lines');lines.scrollTop=lines.scrollHeight;
    typed=0;currentRow=null;index++;later(kind==='output'?900:kind==='result'?1300:650);
  }
  function reset(){cancel();entries=scenes[key]();index=0;typed=0;currentRow=null;const p=panel();if(!p)return;p.querySelector('.terminal-lines').replaceChildren();p.querySelector('.terminal-accessible').textContent=entries.map(e=>e[1]).join('\n');if(reduced.matches){entries.forEach(([kind,value])=>makeRow(kind,(kind==='command'?'› ':'')+value));const lines=p.querySelector('.terminal-lines');lines.scrollTop=lines.scrollHeight;status(text('예시 결과','Sample result'));}else{status(paused?text('일시정지','Paused'):text('시작 대기','Ready'));later(200);}controls();}
  document.addEventListener('kubeast:scene',e=>{key=e.detail.key;reset();});
  terminal.addEventListener('click',e=>{if(e.target.closest('[data-run-toggle]')){paused=!paused;controls();if(paused){cancel();status(text('일시정지','Paused'));}else later(80);}if(e.target.closest('[data-run-replay]')){paused=false;reset();}});
  key=document.querySelector('[data-depth][aria-pressed="true"]').dataset.depth;reset();

  // Motion belongs to visible sections. Inactive sections keep no timers running.
  const regions=[terminal,...document.querySelectorAll('.permission-panel,.investigation-panel,.arch-diagram')];
  regions.forEach(node=>node.classList.add('motion-region'));
  const observer=new IntersectionObserver(items=>{for(const item of items){item.target.classList.toggle('is-in-view',item.isIntersecting);if(item.target===terminal){visible=item.isIntersecting;if(visible)later(100);else cancel();}}},{threshold:.12});
  regions.forEach(node=>observer.observe(node));

  // Solid paths remain visible; independent packets run over their measured routes.
  const ns='http://www.w3.org/2000/svg';
  function path(svg,d,color,duration,delay,flow=true){
    const base=document.createElementNS(ns,'path');base.setAttribute('d',d);base.setAttribute('class','connection-base');base.style.stroke=color;svg.append(base);
    if(flow){const packet=base.cloneNode();packet.setAttribute('class','connection-packet');packet.setAttribute('pathLength','100');packet.style.setProperty('--duration',duration+'s');packet.style.setProperty('--delay',delay+'s');svg.append(packet);}
    return base;
  }
  const diagram=document.querySelector('.permission-diagram'),svg=document.createElementNS(ns,'svg');
  svg.setAttribute('class','permission-flow');svg.setAttribute('aria-hidden','true');diagram.prepend(svg);
  function permissionPath(){
    const box=diagram.getBoundingClientRect();if(!box.width)return;svg.setAttribute('viewBox','0 0 '+box.width+' '+box.height);svg.replaceChildren();
    const person=diagram.querySelector('.diagram-person b').getBoundingClientRect(),gate=diagram.querySelector('.permission-gate').getBoundingClientRect();
    const y=gate.top-box.top+gate.height/2,py=person.top-box.top+person.height/2,gx=gate.right-box.left;
    path(svg,`M${person.right-box.left} ${py} C${person.right-box.left+16} ${py} ${gate.left-box.left-16} ${y} ${gate.left-box.left} ${y}`,'#7dd3fc',3.2,0);
    // One line per request row, in its outcome's colour; a refused request's line carries no packet.
    const colors={ok:'#61d9ae',approve:'#f1b86c',no:'#7e8996',mask:'#8d9bb0'};
    diagram.querySelectorAll('.target').forEach((target,i)=>{const r=target.getBoundingClientRect(),tx=r.left-box.left,ty=r.top-box.top+r.height/2,outcome=target.dataset.outcome||'ok';path(svg,`M${gx} ${y} C${gx+22} ${y} ${tx-24} ${ty} ${tx} ${ty}`,colors[outcome]||colors.ok,3.8+i*.6,-i*.9,outcome!=='no');});
  }
  new ResizeObserver(permissionPath).observe(diagram);document.addEventListener('kubeast:permission',permissionPath);permissionPath();

  // How Kubeast works: a route per link, across on wide screens (the CSS's min-width 1101px) and down when the groups stack.
  // A row of boxes gets a route each; a group that wraps gets one to its middle. Off by default: dashed, no packet.
  const arch=document.querySelector('.arch-diagram'),archSvg=document.createElementNS(ns,'svg'),archWide=matchMedia('(min-width: 1101px)');
  archSvg.setAttribute('class','arch-flow');archSvg.setAttribute('aria-hidden','true');arch.prepend(archSvg);
  function archPaths(){
    const box=arch.getBoundingClientRect();if(!box.width)return;archSvg.setAttribute('viewBox',`0 0 ${box.width} ${box.height}`);archSvg.replaceChildren();
    const at=selector=>arch.querySelector(selector).getBoundingClientRect(),part=key=>at('[data-arch="'+key+'"]');
    const oneRow=keys=>keys.every(key=>Math.abs(part(key).top-part(keys[0]).top)<3);
    let count=0;
    // near: a route down lands on the target's top edge as close above its source as fits, clear of a caption at the row's left.
    function link(a,b,color,{across=false,off=false,near=false}={}){
      const x1=across?a.right-box.left:a.left-box.left+a.width/2,y1=across?a.top-box.top+a.height/2:a.bottom-box.top;
      const x2=across?b.left-box.left:near?Math.min(Math.max(x1,b.left-box.left+24),b.right-box.left-24):b.left-box.left+b.width/2,y2=across?b.top-box.top+b.height/2:b.top-box.top;
      const d=across?`M${x1} ${y1} C${(x1+x2)/2} ${y1} ${(x1+x2)/2} ${y2} ${x2} ${y2}`:`M${x1} ${y1} C${x1} ${(y1+y2)/2} ${x2} ${(y1+y2)/2} ${x2} ${y2}`;
      const base=path(archSvg,d,color,2.8+count*.23,-count*.55,!off);if(off)base.style.strokeDasharray='3 5';count++;
    }
    const wide=archWide.matches,request='#7dd3fc',asUser='#61d9ae',model='#b9a7f5',kept='#a3b4c9',optional='#8d9bb0';
    const entries=['frontend','mcp','alerts'],services=['auth','ai','k8s','session'],reached=['models','clusters','observability'],gateway=part('gateway');
    if(wide||oneRow(entries))entries.forEach(key=>link(part(key),gateway,request,{across:wide,off:key!=='frontend'}));else link(at('.arch-entry'),gateway,request);
    if(wide||oneRow(services))services.forEach(key=>link(gateway,part(key),request,{across:wide}));else link(gateway,at('.arch-services'),request);
    if(wide||oneRow(services)&&oneRow(reached)){
      link(part('ai'),part('models'),model,{across:wide,near:true});
      link(part('ai'),part('clusters'),asUser,{across:wide});link(part('k8s'),part('clusters'),asUser,{across:wide});
      link(part('k8s'),part('observability'),optional,{across:wide,off:true,near:true});
    }else link(at('.arch-services'),part('clusters'),asUser);
    if(wide){const core=at('.arch-core');['postgres','secrets','cache'].forEach(key=>link(core,part(key),kept));}
    if(oneRow(['postgres','sinks']))link(part('postgres'),part('sinks'),optional,{across:true,off:true});
  }
  new ResizeObserver(archPaths).observe(arch);archWide.addEventListener('change',archPaths);
  new MutationObserver(()=>requestAnimationFrame(archPaths)).observe(root,{attributes:true,attributeFilter:['lang']});archPaths();

  let traceTimer=0,traceVisible=false,tracePaused=false;
  const trace=document.querySelector('.investigation-panel');
  const traceControl=document.createElement('button');traceControl.type='button';traceControl.className='quiet-button trace-auto';traceControl.textContent=text('일시정지','Pause');traceControl.setAttribute('aria-label',text('AI 작업 흐름 일시정지','Pause AI workflow'));document.querySelector('.investigation-copy').append(traceControl);
  function traceLoop(){clearTimeout(traceTimer);if(traceVisible&&!tracePaused&&!document.hidden&&!reduced.matches)traceTimer=setTimeout(()=>{const active=document.querySelector('[data-trace][aria-pressed="true"]');const step=Number(active.dataset.trace);if(step===3||step===4)return;document.querySelector('[data-trace="'+(step+1)+'"]').click();traceLoop();},2800);}
  new IntersectionObserver(items=>{traceVisible=items[0].isIntersecting;traceLoop();},{threshold:.3}).observe(trace);
  function traceControls(){traceControl.textContent=tracePaused?text('재생','Play'):text('일시정지','Pause');traceControl.setAttribute('aria-label',tracePaused?text('AI 작업 흐름 재생','Play AI workflow'):text('AI 작업 흐름 일시정지','Pause AI workflow'));traceControl.setAttribute('aria-pressed',String(tracePaused));}
  traceControl.addEventListener('click',()=>{tracePaused=!tracePaused;traceControls();traceLoop();});
  new MutationObserver(traceControls).observe(root,{attributes:true,attributeFilter:['lang']});
  traceControls();
  document.querySelectorAll('[data-trace],#trace-next,#trace-reset').forEach(b=>b.addEventListener('click',()=>{traceLoop();}));

  const reveals=new IntersectionObserver(items=>{for(const item of items){if(!item.isIntersecting)continue;reveals.unobserve(item.target);if(!reduced.matches&&!document.hidden)item.target.animate([{opacity:.3,transform:'translateY(18px)'},{opacity:1,transform:'translateY(0)'}],{duration:560,easing:'cubic-bezier(.2,.7,.2,1)'});}},{threshold:.08});
  document.querySelectorAll('#inside>.section-head,#integrations>.section-head,#architecture>.section-head,.explain-panel,.arch-layout,.capability-strip,.features .card').forEach(node=>reveals.observe(node));

  // Settle at the right edge after the hero, then join the footer mark.
  const drift=document.querySelector('.brand-drift');let frame=0,current=null;
  const clamp=v=>Math.max(0,Math.min(1,v)),ease=v=>v*v*(3-2*v),mix=(a,b,t)=>a+(b-a)*t;
  function draw(){frame=0;const w=innerWidth,h=innerHeight,hero=document.getElementById('hero-title').getBoundingClientRect(),foot=document.getElementById('footer-mark').getBoundingClientRect();
    const start=Math.min(900,w*.85),size=Math.min(1300,w*1.05),intro=reduced.matches?0:ease(clamp(scrollY/900)),end=reduced.matches?0:ease(clamp(1-(foot.top-h*.45)/(h*.6)));
    // Below the hero the mark stays at about half its strength, as the hero leaves the screen; with reduced motion in one step.
    const left=clamp(1-document.getElementById('hero').getBoundingClientRect().bottom/h),past=reduced.matches?(left<.5?0:1):ease(left);
    const target={x:mix(mix(w/2,w-size*.2,intro),foot.left+foot.width/2,end),y:mix(mix(hero.top+hero.height/2,h*.55,intro),foot.top+foot.height/2,end),size:mix(mix(start,size,intro),foot.width,end),opacity:mix(.12,.05,past)*(1-clamp(end/.85))};
    if(!current||reduced.matches)current={...target};let unsettled=false;for(const k of Object.keys(target)){const delta=target[k]-current[k];current[k]+=delta*.15;if(Math.abs(delta)>(k==='opacity'?.001:.3))unsettled=true;}
    drift.style.width=current.size+'px';drift.style.transform=`translate3d(${current.x-current.size/2}px,${current.y-current.size/2}px,0)`;drift.style.opacity=current.opacity;
    if(unsettled&&!reduced.matches&&!document.hidden)frame=requestAnimationFrame(draw);
  }
  function queue(){if(reduced.matches)return draw();if(!frame&&!document.hidden)frame=requestAnimationFrame(draw);}
  addEventListener('scroll',queue,{passive:true});addEventListener('resize',queue,{passive:true});draw();
  document.addEventListener('visibilitychange',()=>{root.classList.toggle('motion-document-hidden',document.hidden);if(document.hidden){cancel();clearTimeout(traceTimer);if(frame)cancelAnimationFrame(frame);frame=0;}else{later(200);traceLoop();queue();}});
  reduced.addEventListener('change',()=>{reset();traceLoop();root.classList.toggle('motion-reduced',reduced.matches);if(frame)cancelAnimationFrame(frame);frame=0;queue();});
  root.classList.toggle('motion-reduced',reduced.matches);
})();
