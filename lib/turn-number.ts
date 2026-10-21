export interface TurnNumberCalculationInput {
  messages: readonly { role: string }[];
  navigationTotalTurns?: number | null;
  hasEarlierMessages?: boolean;
}

/**
 * 计算用户消息的轮次序号（#1, #2, ...）。
 *
 * 契约不变量：
 * 1. 仅对 role === "user" 的消息编号，工具和 assistant 等非 user 消息不计入轮次。
 * 2. 同文不同 user 记录各计一次。
 * 3. 当 hasEarlierMessages 为 false 时（已加载完整最早历史，无更早消息），从 #1 开始按顺序编号。
 * 4. 当 hasEarlierMessages 为 true 时（partial 历史，前面有未加载的历史）：
 *    - 如果 navigationTotalTurns 是有效正整数且 >= 已加载的 user 消息数，
 *      offset = navigationTotalTurns - loadedUserCount，编号为 offset + i + 1。
 *    - 若 partial 历史缺少真正可信的 total（<= 0 或小于已加载数或未提供），
 *      绝不冒称全局 #1，保守不展示无法确定的序号（不分配 turnNumber）。
 * 5. 返回 Map<number, number>，key 为消息在 messages 中的原始索引，value 为 turnNumber。
 */
export function computeUserTurnNumbers(input: TurnNumberCalculationInput): Map<number, number> {
  const result = new Map<number, number>();
  const { messages, navigationTotalTurns, hasEarlierMessages = false } = input;
  if (!messages || messages.length === 0) {
    return result;
  }

  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      userIndices.push(i);
    }
  }

  const userCount = userIndices.length;
  if (userCount === 0) {
    return result;
  }

  let offset = 0;
  if (hasEarlierMessages) {
    if (
      typeof navigationTotalTurns === "number" &&
      Number.isSafeInteger(navigationTotalTurns) &&
      navigationTotalTurns >= userCount
    ) {
      offset = navigationTotalTurns - userCount;
    } else {
      // partial 历史缺真正 total，不可冒称全局 #1，保守不展示无法确定的序号
      return result;
    }
  } else {
    offset = 0;
  }

  for (let i = 0; i < userCount; i++) {
    result.set(userIndices[i], offset + i + 1);
  }

  return result;
}
