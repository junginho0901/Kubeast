# Multi-turn tool calling 구현 예시

async def session_chat_stream_multiturn(self, session_id: str, message: str):
    """세션 기반 AI 챗봇 (Multi-turn Tool Calling)"""
    from app.database import get_db_service
    
    try:
        db = await get_db_service()
        
        # 세션 확인
        session = await db.get_session(session_id)
        if not session:
            yield f"data: {json.dumps({'type': 'error', 'content': 'Session not found'})}\n\n"
            return
        
        # 사용자 메시지 저장
        await db.add_message(session_id, "user", message)
        
        # 대화 히스토리 가져오기
        messages_history = await db.get_messages(session_id)
        
        # GPT 메시지 형식으로 변환
        messages = [{"role": "system", "content": self._get_system_message()}]
        for msg in messages_history:
            if msg.role in ["user", "assistant"]:
                messages.append({"role": msg.role, "content": msg.content})
        
        # Tool Context 가져오기 또는 생성
        if session_id not in self.tool_contexts:
            self.tool_contexts[session_id] = ToolContext(session_id)
            context_data = await db.get_context(session_id)
            if context_data:
                self.tool_contexts[session_id].state = context_data.state or {}
                self.tool_contexts[session_id].cache = context_data.cache or {}
        
        tool_context = self.tool_contexts[session_id]
        tools = self._get_tools_definition()
        
        # ===== Multi-turn Tool Calling Loop =====
        max_iterations = 5
        iteration = 0
        assistant_content = ""
        
        while iteration < max_iterations:
            iteration += 1
            print(f"[DEBUG] Iteration {iteration}/{max_iterations}")
            
            # GPT 호출
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.7
            )
            
            response_message = response.choices[0].message
            
            # Tool call이 있으면 실행
            if response_message.tool_calls:
                print(f"[DEBUG] Tool calls: {len(response_message.tool_calls)}")
                messages.append(response_message)
                
                for tool_call in response_message.tool_calls:
                    function_name = tool_call.function.name
                    function_args = json.loads(tool_call.function.arguments)
                    
                    # 프론트엔드에 알림
                    yield f"data: {json.dumps({'function': function_name, 'args': function_args}, ensure_ascii=False)}\n\n"
                    
                    # 함수 실행
                    function_response = await self._execute_function_with_context(
                        function_name,
                        function_args,
                        tool_context
                    )
                    
                    messages.append({
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": str(function_response)
                    })
                
                # 다음 iteration으로
                continue
            
            # Tool call이 없으면 최종 응답 (스트리밍)
            else:
                print(f"[DEBUG] Final response, streaming...")
                
                # 응답 내용이 있으면 그대로 사용
                if response_message.content:
                    assistant_content = response_message.content
                    yield f"data: {json.dumps({'content': assistant_content}, ensure_ascii=False)}\n\n"
                
                # 없으면 스트리밍 모드로 다시 호출
                else:
                    messages.append(response_message)
                    stream = await self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        temperature=0.7,
                        max_tokens=4096,
                        stream=True
                    )
                    
                    async for chunk in stream:
                        if chunk.choices[0].delta.content:
                            content = chunk.choices[0].delta.content
                            assistant_content += content
                            yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"
                
                # 루프 종료
                break
        
        # Max iterations 도달
        if iteration >= max_iterations and not assistant_content:
            assistant_content = "최대 반복 횟수에 도달했습니다. 더 구체적인 질문으로 다시 시도해주세요."
            yield f"data: {json.dumps({'content': assistant_content}, ensure_ascii=False)}\n\n"
        
        # Assistant 메시지 저장
        await db.add_message(session_id, "assistant", assistant_content)
        
        # Tool Context 저장
        await db.update_context(
            session_id,
            state=tool_context.state,
            cache=tool_context.cache
        )
        
        # 세션 제목 자동 생성
        if len(messages_history) <= 1:
            title = message[:50] + "..." if len(message) > 50 else message
            await db.update_session_title(session_id, title)
        
        yield "data: [DONE]\n\n"
    
    except Exception as e:
        print(f"[ERROR] Session chat error: {e}")
        yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
