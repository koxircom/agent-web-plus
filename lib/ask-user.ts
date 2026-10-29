import type { AskUserQuestion } from "./types";
import { asBracketedPaste } from "./terminal-input";

export function cleanAskText(value: string): string {
  return value.replace(/<!--[^]*?-->|&lt;!--[^]*?--&gt;/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

export function readAskTerminal(lines: string[]) {
  const text = cleanAskText(lines.join("\n"));
  const rows = text.split("\n").filter(line => !/^\s*[╭╰┌└]/.test(line)).map(line => line.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "").trim());
  const heading = rows.findIndex(line => line === "Question");
  const questionStart = heading < 0 ? 0 : heading + 1;
  const questionEnd = rows.findIndex((line, index) => index >= questionStart && /^(?:Context|Filter:|(?:(?:→|->|›|❯|>)\s*)?\d+\.)/.test(line));
  const question = rows.slice(questionStart, questionEnd < 0 ? undefined : questionEnd).filter(Boolean).join(" ");
  const options = rows.flatMap(line => {
    const match = line.match(/^(?:(→|->|›|❯|>)\s*)?(\d+)\.\s+(?:\[([^\]]*)\]\s+)?(.+?)(?:\s+│.*)?$/);
    if (!match || /^(?:Type something\.|Add extra context)/i.test(match[4])) return [];
    return [{ number: Number(match[2]), title: match[4].trim(), checked: /[✓xX]/.test(match[3] ?? ""), current: Boolean(match[1]) }];
  });
  const currentRow = rows.find(line => /^(?:→|->|›|❯|>)\s*\d+\./.test(line));
  return {
    text, question, options,
    cursor: currentRow ? Number(currentRow.match(/\d+/)?.[0]) - 1 : 0,
    comment: /Add extra context after selection/i.test(text),
    commentEnabled: /\[✓\]\s*Add extra context after selection/i.test(text),
    freeform: /Type (?:something|custom response|your answer)/i.test(text),
    mode: /\bCustom response\b/.test(text) ? "freeform" : /Selected options?:/.test(text) ? "comment" : "select",
  };
}

/** Bind only one unresolved, matching tool call. Never borrow another question's metadata. */
export function findAskUserQuestion(lines: string[], messages: unknown, defaultComment = false): AskUserQuestion | undefined {
  if (!Array.isArray(messages) || !/\bask_user\b/.test(lines.join("\n"))) return;
  const terminal = readAskTerminal(lines);
  if (!terminal.question) return;
  const pending = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message?.role === "toolResult") pending.delete(message.toolCallId);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if ((block.name ?? block.toolName) !== "ask_user" || block.type !== "toolCall") continue;
      const id = block.id ?? block.toolCallId;
      const args = block.arguments ?? block.input;
      if (typeof id === "string" && args && typeof args.question === "string") pending.set(id, args);
    }
  }
  const normalize = (value: string) => cleanAskText(value).replace(/\s/g, "");
  const optionsOf = (args: Record<string, unknown>) => (Array.isArray(args.options) ? args.options : [])
    .map(option => typeof option === "string" ? { title: option } : option)
    .filter(option => option && typeof option.title === "string" && option.title.trim());
  const matches = [...pending].filter(([, args]) => {
    const question = normalize(args.question as string), visible = normalize(terminal.question);
    if (question !== visible && !(visible.length >= 12 && question.startsWith(visible.replace(/[….]+$/, "")))) return false;
    const options = optionsOf(args);
    return terminal.options.every(option => {
      const source = options[option.number - 1];
      return source && typeof source.title === "string" && normalize(source.title).startsWith(normalize(option.title).replace(/[….]+$/, ""));
    });
  });
  if (matches.length !== 1) return;
  const [toolCallId, args] = matches[0];
  const options = optionsOf(args);
  return {
    toolCallId, question: cleanAskText(args.question as string),
    context: typeof args.context === "string" ? cleanAskText(args.context) : undefined,
    options: options.map(option => ({ title: cleanAskText(option.title), description: typeof option.description === "string" ? cleanAskText(option.description) : undefined })),
    allowMultiple: args.allowMultiple === true,
    allowFreeform: args.allowFreeform !== false,
    // An environment default can enable comment even when the tool omits it.
    allowComment: typeof args.allowComment === "boolean" ? args.allowComment : terminal.comment || defaultComment,
  };
}

/** One bounded ordered batch over the existing terminal protocol, without timers or DOM events. */
export function buildAskAnswerInputs(question: AskUserQuestion, lines: string[], selected: number[], notes: string, freeform: boolean): string[] {
  const terminal = readAskTerminal(lines);
  const inputs: string[] = [];
  if (terminal.mode !== "select") return [asBracketedPaste(notes), "\r"];
  // Terminal viewports can omit the off-screen comment/freeform rows.
  // Complete tool metadata, not clipped terminal lines, defines the item count.
  const count = question.options.length + Number(Boolean(question.allowComment)) + Number(Boolean(question.allowFreeform));
  let cursor = terminal.cursor;
  const move = (target: number) => {
    const delta = (target - cursor + count) % count;
    inputs.push(...Array(delta).fill("\x1b[B")); cursor = target;
  };
  if (freeform) {
    if (!question.allowFreeform || !notes.trim()) throw new Error("请输入自定义回答");
    move(question.options.length + Number(Boolean(question.allowComment)));
    return [...inputs, "\r", asBracketedPaste(notes), "\r"];
  }
  if (!selected.length || selected.some(index => !Number.isInteger(index) || index < 0 || index >= question.options.length)) throw new Error("请选择一个答案");
  if (question.allowMultiple) {
    for (let index = 0; index < question.options.length; index++) {
      if (Boolean(terminal.options.find(option => option.number === index + 1)?.checked) !== selected.includes(index)) {
        move(index); inputs.push(" ");
      }
    }
  }
  if (question.allowComment && terminal.commentEnabled !== Boolean(notes.trim())) {
    move(question.options.length); inputs.push(" ");
  }
  if (notes.trim() && !question.allowComment) throw new Error("本次提问未开启补充说明，请选择自定义回答");
  move(selected[0]); inputs.push("\r");
  if (notes.trim()) inputs.push(asBracketedPaste(notes), "\r");
  return inputs;
}
