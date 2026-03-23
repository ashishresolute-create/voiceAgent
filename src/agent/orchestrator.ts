// src/agent/orchestrator.ts
import Anthropic from '@anthropic-ai/sdk';
import { appointmentTools, executeToolCall } from '../scheduling/tools';
import type { SessionMemory } from '../memory/session';
import type { LongTermMemory } from '../memory/longTerm';
import type { Language } from '../utils/languageDetect';
import { buildSystemPrompt } from './prompt';
import { logger } from '../utils/logger';

const client = new Anthropic();

interface OrchestratorOptions {
  sessionMemory: SessionMemory;
  ltm: LongTermMemory;
  patientContext: PatientContext | null;
  callSid: string;
}

export interface PatientContext {
  patientId: string;
  name?: string;
  preferredLang: Language;
  recentMemories: string[];
  upcomingAppointments: string[];
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export class AgentOrchestrator {
  private opts: OrchestratorOptions;
  private conversationHistory: Message[] = [];
  private reasoningLog: string[] = [];

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
  }

  async *streamResponse(userText: string, language: Language): AsyncGenerator<string> {
    // Handle synthetic call-start trigger
    const isCallStart = userText === '[CALL_START]';

    if (!isCallStart) {
      this.conversationHistory.push({ role: 'user', content: userText });
    }

    const systemPrompt = buildSystemPrompt({
      language,
      patientContext: this.opts.patientContext,
      sessionState: this.opts.sessionMemory.getAll(),
      isCallStart,
    });

    const messages = isCallStart
      ? [{ role: 'user' as const, content: 'Begin the call with a greeting.' }]
      : this.conversationHistory.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

    let fullResponse = '';
    let pendingToolCalls: Anthropic.ToolUseBlock[] = [];

    // Agentic loop: stream → collect tool calls → execute → re-stream
    let continueLoop = true;
    while (continueLoop) {
      const stream = await client.messages.stream({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,           // Short responses = lower latency
        system: systemPrompt,
        messages,
        tools: appointmentTools,
        tool_choice: { type: 'auto' },
      });

      let currentText = '';
      pendingToolCalls = [];

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const token = event.delta.text;
            currentText += token;
            fullResponse += token;
            yield token;                // Stream to TTS as tokens arrive
          }
        }

        if (event.type === 'message_delta') {
          // Collect tool calls
          if (stream.finalMessage) {
            for (const block of stream.finalMessage.content) {
              if (block.type === 'tool_use') {
                pendingToolCalls.push(block);
              }
            }
          }
        }
      }

      const finalMsg = await stream.finalMessage();

      if (finalMsg.stop_reason === 'tool_use') {
        // Execute all tool calls
        const toolResults: Anthropic.MessageParam = {
          role: 'user',
          content: [],
        };

        for (const toolCall of finalMsg.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )) {
          logger.info({ tool: toolCall.name, input: toolCall.input }, 'Tool call');
          this.reasoningLog.push(`TOOL: ${toolCall.name}(${JSON.stringify(toolCall.input)})`);

          const result = await executeToolCall(
            toolCall.name,
            toolCall.input as Record<string, unknown>,
            this.opts.patientContext
          );

          logger.info({ tool: toolCall.name, result }, 'Tool result');
          this.reasoningLog.push(`RESULT: ${JSON.stringify(result)}`);

          (toolResults.content as Anthropic.ToolResultBlockParam[]).push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }

        // Update messages for next loop iteration
        messages.push(
          { role: 'assistant', content: finalMsg.content } as any,
          toolResults
        );
        continueLoop = true;
      } else {
        // Natural end — no more tool calls
        continueLoop = false;
      }
    }

    // Store assistant response in history
    if (fullResponse) {
      this.conversationHistory.push({ role: 'assistant', content: fullResponse });
      this.opts.sessionMemory.addMessage('assistant', fullResponse);
    }

    if (!isCallStart) {
      this.opts.sessionMemory.addMessage('user', userText);
    }

    // Expose reasoning traces
    logger.debug({ reasoning: this.reasoningLog }, 'Agent reasoning trace');
  }

  getReasoningTrace(): string[] {
    return [...this.reasoningLog];
  }
}
