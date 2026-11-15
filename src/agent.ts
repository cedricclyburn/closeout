import { Agent, CursorAgentError } from "@cursor/sdk";

import type { AgentEditResult } from "./domain.ts";

const DEFAULT_MODEL = "composer-2.5";

export async function runAgent(input: {
  cwd: string;
  prompt: string;
  agentId?: string;
}): Promise<AgentEditResult> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return {
      outcome: "startup-error",
      message: "CURSOR_API_KEY is not set",
      retryable: false,
      agentId: null,
      runId: null,
    };
  }

  const model = { id: process.env.CURSOR_MODEL || DEFAULT_MODEL };
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  let runId: string | null = null;
  try {
    agent = input.agentId
      ? await Agent.resume(input.agentId, {
          apiKey,
          model,
          local: { cwd: input.cwd, settingSources: [] },
        })
      : await Agent.create({
          apiKey,
          name: "closeout",
          model,
          local: { cwd: input.cwd, settingSources: [] },
        });
    const run = await agent.send(input.prompt);
    runId = run.id;
    process.stdout.write(`agent ${agent.agentId}\nrun ${run.id}\n`);
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
          }
        }
      }
    }
    process.stdout.write("\n");
    const result = await run.wait();
    if (result.status === "error" || result.status === "cancelled") {
      return {
        outcome: "run-error",
        message: result.error?.message ?? result.status,
        agentId: agent.agentId,
        runId: result.id,
      };
    }
    return { outcome: "finished", agentId: agent.agentId, runId: result.id };
  } catch (error) {
    if (error instanceof CursorAgentError) {
      if (runId && agent) {
        return {
          outcome: "run-error",
          message: error.message,
          agentId: agent.agentId,
          runId,
        };
      }
      return {
        outcome: "startup-error",
        message: error.message,
        retryable: error.isRetryable,
        agentId: agent?.agentId ?? input.agentId ?? null,
        runId: null,
      };
    }
    throw error;
  } finally {
    if (agent) {
      await agent[Symbol.asyncDispose]().catch(() => undefined);
    }
  }
}
