import type { AgentMessage } from './types';

export interface InlineSuggestion {
  id: string;
  sessionId: string;
  text: string;
}

function suggestionText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? text : null;
}

/** Only completed, currently loaded conversation data is used; never fetch history or call a model. */
export function getInlineSuggestion(messages: AgentMessage[], entryIds: string[], sessionId: string): InlineSuggestion | null {
  if (!sessionId) return null;
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') break;
    if (messages[index].role === 'assistant') { assistantIndex = index; break; }
  }
  if (assistantIndex < 0) return null;
  const assistant = messages[assistantIndex];
  if (assistant.role !== 'assistant' || assistant.errorMessage || ['error', 'aborted', 'toolUse'].includes(assistant.stopReason ?? '')) return null;
  const assistantId = entryIds[assistantIndex];
  if (!assistantId) return null;
  const result = (text: string): InlineSuggestion => ({id: assistantId, sessionId, text});
  for (let index = messages.length - 1; index > assistantIndex; index--) {
    const message = messages[index];
    if (message.role !== 'custom' || message.customType !== 'pi-quick-action-analysis') continue;
    const details = message.details as {schemaVersion?: number; sessionId?: string; assistantEntryId?: string; status?: string; action?: {enabled?: boolean; message?: unknown}} | null;
    // The old classifier decides whether to show a quick-action button.
    // Its none/pending/error decision must not suppress an explicit next step
    // in the current reply. Never reuse an older or differently scoped action.
    if (details?.schemaVersion === 1 && details.sessionId === sessionId && details.assistantEntryId === assistantId && details.status === 'ready' && details.action?.enabled === true) {
      const text = suggestionText(details.action.message);
      if (text) return result(text);
    }
    break;
  }
  const body = assistant.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  // Ignore code, quoted examples, and earlier sections. Keep the first explicitly suggested next step.
  const prose = body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/^>.*$/gm, '');
  const heading = /^(?:#{1,6}\s*)?(?:\*\*)?(?:优化建议|下一步建议|下一步|建议下一步|Next steps?)(?=[\s：:*]|$)\s*[:：]?\s*(?:\*\*)?\s*[:：]?\s*(.*)$/gim;
  let match: RegExpExecArray | null, latest: RegExpExecArray | null = null;
  while ((match = heading.exec(prose))) latest = match;
  if (!latest) return null;
  const rest = [latest[1], prose.slice(latest.index + latest[0].length)].join('\n');
  const lines: string[] = [];
  for (const line of rest.split('\n')) {
    if (/^\s*#{1,6}\s/.test(line) || (lines.length && /^\s*(?:[-*+] |\d+[.)、] )/.test(line))) break;
    if (!line.trim()) { if (lines.length) break; continue; }
    lines.push(line.replace(/^\s*(?:[-*+] |\d+[.)、] )/, '').trim());
  }
  let text = lines.join(' ').replace(/\[([^\]]+)\]\([^\n)]+\)/g, '$1').replace(/\*\*|__|`/g, '').trim();
  text = text.replace(/^(?:建议(?:你|您)?|下一步(?:可以|可)?|你可以|您可以|可以(?:先)?|后续(?:可以|可))[，,：:\s]*/, '');
  if (!text || text.length > 480) return null;
  text = /^(?:请|帮我|请帮我|继续|按照|按这个|把|将)/.test(text) ? text : `帮我${text}`;
  return suggestionText(text) ? result(text) : null;
}

export type SuggestionTap = {time: number; x: number; y: number; key: string};
/** Local gesture policy; scrolling and multiple touches are rejected by the native textarea handlers. */
export function isSuggestionDoubleTap(previous: SuggestionTap | null, next: SuggestionTap): boolean {
  return Boolean(previous && previous.key === next.key && next.time >= previous.time
    && next.time - previous.time <= 300 && Math.hypot(next.x - previous.x, next.y - previous.y) <= 24);
}
