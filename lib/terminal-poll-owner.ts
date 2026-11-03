export interface TerminalPoll {
  generation: number;
  controller: AbortController;
}

export function createTerminalPollOwner() {
  let generation = 0;
  let current: TerminalPoll | null = null;

  return {
    begin(): TerminalPoll | null {
      if (current) return null;
      current = { generation: ++generation, controller: new AbortController() };
      return current;
    },
    isCurrent(poll: TerminalPoll): boolean {
      return current === poll && poll.generation === generation;
    },
    finish(poll: TerminalPoll): boolean {
      if (current !== poll || poll.generation !== generation) return false;
      current = null;
      return true;
    },
    stop(): void {
      generation++;
      current?.controller.abort();
      current = null;
    },
  };
}
